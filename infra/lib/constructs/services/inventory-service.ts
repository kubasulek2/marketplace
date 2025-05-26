import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
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

export type InventoryServiceProps = {
  vpc: Vpc;
  appConfig: AppConfig;
  eventBus: sns.Topic;
};

export class InventoryService extends Construct {
  public readonly lambda: Function;

  constructor(scope: Construct, id: string, props: InventoryServiceProps) {
    super(scope, id);

    const table = new Table(this, 'InventoryTable', {
      partitionKey: { name: 'productId', type: AttributeType.STRING },
      sortKey: { name: 'amount', type: AttributeType.NUMBER },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: getEnvSpecificName('InventoryTable'),
      encryption: TableEncryption.AWS_MANAGED,
    });

    const lambdaRole = new Role(this, 'InventoryLambdaRole', {
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

    lambdaRole.addToPolicy(
      new PolicyStatement({
        actions: ['sns:Publish'],
        resources: [props.eventBus.topicArn],
      })
    );

    this.lambda = new Function(this, getEnvSpecificName('InventoryLambda'), {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline(`
        const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
        const client = new DynamoDBClient({});
        const TABLE_NAME = process.env.TABLE_NAME;
        exports.handler = async (event) => {
          try {
            const data = await client.send(new ScanCommand({ TableName: TABLE_NAME }));
            return {
              statusCode: 200,
              body: JSON.stringify(data.Items),
              headers: { 'Content-Type': 'application/json' },
            };
          } catch (err) {
            return {
              statusCode: 500,
              body: JSON.stringify({ error: err.message }),
              headers: { 'Content-Type': 'application/json' },
            };
          };
        };
      `),
      timeout: Duration.seconds(30),
      memorySize: 256,
      vpc: props.appConfig.usePrivateSubnets ? props.vpc : undefined,
      environment: {
        NO_COLOR: 'true',
        TABLE_NAME: getEnvSpecificName('InventoryTable'),
      },
      functionName: getEnvSpecificName('InventoryLambda'),
      logGroup: LogGroup.fromLogGroupName(
        this,
        'InventoryLambdaLogGroup',
        `/aws/lambda/${getEnvSpecificName('InventoryLambda')}`
      ),
    });

    table.grantReadWriteData(this.lambda);

    const dlq = new Queue(this, 'InventoryDLQ', {
      queueName: getEnvSpecificName('InventoryDLQ'),
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const queue = new Queue(this, 'InventoryQueue', {
      queueName: getEnvSpecificName('InventoryQueue'),
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
            matchPrefixes: ['inventory.'],
            allowlist: ['order.paid'],
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
