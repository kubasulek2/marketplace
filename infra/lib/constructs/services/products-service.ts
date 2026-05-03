import * as path from 'path';

import { Duration } from 'aws-cdk-lib';
import { Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { AppConfig } from '../../shared/config';
import { scalingConfig } from '../../shared/scaling-config';
import { getEnvSpecificName } from '../../shared/getEnvSpecificName';
import { ProductsAurora } from '../products-aurora';

export type ProductsServiceProps = {
  vpc: Vpc;
  appConfig: AppConfig;
  eventBus: sns.Topic;
};

export class ProductsService extends Construct {
  public readonly lambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: ProductsServiceProps) {
    super(scope, id);

    const db = new ProductsAurora(this, 'ProductsAurora', {
      appConfig: props.appConfig,
      vpc: props.vpc,
    });

    const lambdaRole = new Role(this, 'ProductsLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    lambdaRole.addToPolicy(
      new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [props.eventBus.topicArn],
      })
    );

    db.cluster.secret?.grantRead(lambdaRole);

    const lambdaSG = new SecurityGroup(this, 'ProductsLambdaSG', {
      vpc: props.vpc,
      description: 'Security group for Products Lambda',
      allowAllOutbound: true,
    });

    db.dbSecurityGroup.addIngressRule(lambdaSG, Port.tcp(5432), 'Allow Lambda to access RDS Proxy');

    this.lambda = new NodejsFunction(this, getEnvSpecificName('ProductsLambda'), {
      entry: path.join(__dirname, '../../../../services/products/src/index.ts'),
      runtime: Runtime.NODEJS_22_X,
      handler: 'handler',
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['pg'],
      },
      tracing: Tracing.ACTIVE,
      timeout: Duration.seconds(scalingConfig.lambdaTimeoutSeconds),
      memorySize: scalingConfig.lambdaMemoryMb,
      vpc: props.vpc,
      allowPublicSubnet: true,
      vpcSubnets: {
        subnetType: props.appConfig.usePrivateSubnets
          ? SubnetType.PRIVATE_WITH_EGRESS
          : SubnetType.PUBLIC,
      },
      securityGroups: [lambdaSG],
      role: lambdaRole,
      environment: {
        DB_ENDPOINT: db.endpoint,
        NO_COLOR: 'true',
        DB_SECRET_ARN: db.cluster.secret!.secretArn,
      },
      functionName: getEnvSpecificName('ProductsLambda'),
      logGroup: LogGroup.fromLogGroupName(
        this,
        'ProductsLambdaLogGroup',
        `/aws/lambda/${getEnvSpecificName('ProductsLambda')}`
      ),
    });

    const dlq = new Queue(this, 'ProductsDLQ', {
      queueName: getEnvSpecificName('ProductsDLQ'),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const queue = new Queue(this, 'ProductsQueue', {
      queueName: getEnvSpecificName('ProductsQueue'),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(30),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: dlq,
      },
    });

    queue.grantConsumeMessages(this.lambda);

    this.lambda.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        enabled: true,
      })
    );

    props.eventBus.addSubscription(
      new subscriptions.SqsSubscription(queue, {
        rawMessageDelivery: true,
        filterPolicy: {
          subject: sns.SubscriptionFilter.stringFilter({
            matchPrefixes: ['product.'],
          }),
        },
      })
    );

    queue.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [queue.queueArn],
        conditions: {
          ArnEquals: {
            'aws:SourceArn': props.eventBus.topicArn,
          },
        },
      })
    );
  }
}
