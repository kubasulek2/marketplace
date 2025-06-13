import { Duration } from 'aws-cdk-lib';
import { Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { AppConfig } from '../../shared/config';
import { getEnvSpecificName } from '../../shared/getEnvSpecificName';
import { ProductsAurora } from '../products-aurora';

export type ProductsServiceProps = {
  vpc: Vpc;
  appConfig: AppConfig;
  eventBus: sns.Topic;
};

export class ProductsService extends Construct {
  public readonly lambda: Function;

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

    // Allow Lambda security group to access RDS Proxy on port 5432
    db.dbSecurityGroup.addIngressRule(lambdaSG, Port.tcp(5432), 'Allow Lambda to access RDS Proxy');

    this.lambda = new Function(this, getEnvSpecificName('ProductsLambda'), {
      runtime: Runtime.NODEJS_22_X,
      securityGroups: [lambdaSG],
      handler: 'index.handler',
      code: Code.fromInline(`
  // const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  // const { Client } = require('pg');

  // const secretsClient = new SecretsManagerClient();

  // let cachedSecret = null;

  // async function getDbCredentials(secretArn) {
  //   if (cachedSecret) return cachedSecret;

  //   const command = new GetSecretValueCommand({ SecretId: secretArn });
  //   const response = await secretsClient.send(command);

  //   const secretString = response.SecretString;
  //   cachedSecret = JSON.parse(secretString);
  //   return cachedSecret;
  // }

exports.handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello, world!' }),
    headers: { 'Content-Type': 'application/json' },
  };
  //   const secretArn = process.env.DB_SECRET_ARN;
  //   const creds = await getDbCredentials(secretArn);

  //   const client = new Client({
  //     host: process.env.DB_ENDPOINT,
  //     user: creds.username,
  //     password: creds.password,
  //     database: 'products',
  //     port: 5432,
  //     ssl: {
  //       rejectUnauthorized: true,
  //     },
  //   });

  //   await client.connect();

  //   const res = await client.query('SELECT NOW()');

  //   await client.end();

  //   return {
  //     statusCode: 200,
  //     body: JSON.stringify({ time: res.rows[0].now }),
  //   };
  // };
      `),
      timeout: Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      allowPublicSubnet: true,
      vpcSubnets: {
        subnetType: props.appConfig.usePrivateSubnets
          ? SubnetType.PRIVATE_WITH_EGRESS
          : SubnetType.PUBLIC,
      },
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
      visibilityTimeout: Duration.seconds(30), // should be >= Lambda timeout if retrying
      receiveMessageWaitTime: Duration.seconds(20), // long polling
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: dlq,
      },
    });

    // Allow Lambda to poll from the queue
    queue.grantConsumeMessages(this.lambda);

    // Attach SQS trigger to Lambda with max batch size
    this.lambda.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10, // max allowed by Lambda
        enabled: true,
      })
    );

    props.eventBus.addSubscription(
      new subscriptions.SqsSubscription(queue, {
        rawMessageDelivery: true, // if false full message with metadata will be delivered, Message must be JSON parsed
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
