import * as path from 'path';

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
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

export type OrdersServiceProps = {
  vpc: Vpc;
  appConfig: AppConfig;
  eventBus: sns.Topic;
};

export class OrdersService extends Construct {
  public readonly lambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: OrdersServiceProps) {
    super(scope, id);

    const table = new Table(this, 'OrdersTable', {
      partitionKey: { name: 'userId', type: AttributeType.STRING },
      sortKey: { name: 'orderId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: getEnvSpecificName('OrdersTable'),
      encryption: TableEncryption.AWS_MANAGED,
    });

    const lambdaRole = new Role(this, 'OrdersLambdaRole', {
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

    this.lambda = new NodejsFunction(this, getEnvSpecificName('OrdersLambda'), {
      entry: path.join(__dirname, '../../../../services/orders/src/index.ts'),
      runtime: Runtime.NODEJS_22_X,
      handler: 'handler',
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
      tracing: Tracing.ACTIVE,
      timeout: Duration.seconds(scalingConfig.lambdaTimeoutSeconds),
      memorySize: scalingConfig.lambdaMemoryMb,
      vpc: props.appConfig.usePrivateSubnets ? props.vpc : undefined,
      role: lambdaRole,
      environment: {
        TABLE_NAME: getEnvSpecificName('OrdersTable'),
        NO_COLOR: 'true',
      },
      functionName: getEnvSpecificName('OrdersLambda'),
      logGroup: LogGroup.fromLogGroupName(
        this,
        'OrdersLambdaLogGroup',
        `/aws/lambda/${getEnvSpecificName('OrdersLambda')}`
      ),
    });

    table.grantReadWriteData(this.lambda);

    const dlq = new Queue(this, 'OrdersDLQ', {
      queueName: getEnvSpecificName('OrdersDLQ'),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const queue = new Queue(this, 'OrdersQueue', {
      queueName: getEnvSpecificName('OrdersQueue'),
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
            matchPrefixes: ['order.'],
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
