import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { getEnvSpecificName } from '../../shared/getEnvSpecificName';
import { AppEnvironment } from '../../shared/types';

export type InventoryServiceProps = {
  env: AppEnvironment;
  vpc: Vpc;
};

export class InventoryService extends Construct {
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

    // Add permissive SNS publish permissions
    lambdaRole.addToPolicy(
      new PolicyStatement({
        actions: ['sns:Publish'],
        resources: ['*'], // All SNS topics
      })
    );

    const lambda = new Function(this, getEnvSpecificName('InventoryLambda'), {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline(`
        exports.handler = async (event) => {
          return {
            statusCode: 200,
            body: JSON.stringify('Hello World'),
          };
        };
      `),
      timeout: Duration.seconds(900),
      memorySize: 128,
      vpc: props.vpc,
      environment: {
        ENV: props.env,
        NO_COLOR: 'true',
      },
      functionName: getEnvSpecificName('InventoryLambda'),
      logGroup: LogGroup.fromLogGroupName(
        this,
        'InventoryLambdaLogGroup',

        `/aws/lambda/${getEnvSpecificName('InventoryLambda')}`
      ),
    });

    table.grantReadWriteData(lambda);

    const dlq = new Queue(this, 'InventoryDLQ', {
      queueName: getEnvSpecificName('InventoryDLQ'),
      encryption: QueueEncryption.KMS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const queue = new Queue(this, 'InventoryQueue', {
      queueName: getEnvSpecificName('InventoryQueue'),
      encryption: QueueEncryption.KMS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(300), // should be >= Lambda timeout if retrying
      receiveMessageWaitTime: Duration.seconds(20), // long polling
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: dlq,
      },
    });

    // Allow Lambda to poll from the queue
    queue.grantConsumeMessages(lambda);

    // Attach SQS trigger to Lambda with max batch size
    lambda.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10, // max allowed by Lambda
        enabled: true,
      })
    );

    // Allow ECS and API Gateway to invoke Lambda (permissive for now)
    lambda.addPermission('AllowAPIGWInvoke', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    lambda.addPermission('AllowECSInvoke', {
      principal: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });
  }
}
