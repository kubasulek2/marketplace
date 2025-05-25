import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { AppConfig } from '../../shared/config';
import { getEnvSpecificName } from '../../shared/getEnvSpecificName';

export type PaymentsServiceProps = {
  vpc: Vpc;
  appConfig: AppConfig;
};

export class PaymentsService extends Construct {
  public readonly lambda: Function;
  constructor(scope: Construct, id: string, props: PaymentsServiceProps) {
    super(scope, id);

    const table = new Table(this, 'PaymentsTable', {
      partitionKey: { name: 'paymentId', type: AttributeType.STRING },
      sortKey: { name: 'orderId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: getEnvSpecificName('PaymentsTable'),
      encryption: TableEncryption.AWS_MANAGED,
    });

    const lambdaRole = new Role(this, 'PaymentsLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Add permissive SNS publish permissions
    lambdaRole.addToPolicy(
      new PolicyStatement({
        actions: ['sns:Publish'],
        resources: ['*'], // All SNS topics
      })
    );

    this.lambda = new Function(this, getEnvSpecificName('PaymentsLambda'), {
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
        TABLE_NAME: getEnvSpecificName('PaymentsTable'),
        NO_COLOR: 'true',
      },
      functionName: getEnvSpecificName('PaymentsLambda'),
      logGroup: LogGroup.fromLogGroupName(
        this,
        'PaymentsLambdaLogGroup',

        `/aws/lambda/${getEnvSpecificName('PaymentsLambda')}`
      ),
    });

    table.grantReadWriteData(this.lambda);

    const dlq = new Queue(this, 'PaymentsDLQ', {
      queueName: getEnvSpecificName('PaymentsDLQ'),
      encryption: QueueEncryption.KMS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const queue = new Queue(this, 'PaymentsQueue', {
      queueName: getEnvSpecificName('PaymentsQueue'),
      encryption: QueueEncryption.KMS_MANAGED,
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
  }
}
