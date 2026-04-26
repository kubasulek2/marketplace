import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { AppConfig } from '../shared/config';

import { InternalApiGateway } from './internal-api-gateway';
import { OrderSagaStateMachine } from './order-saga-state-machine';
import { InventoryService } from './services/inventory-service';
import { OrdersService } from './services/orders-service';
import { PaymentsService } from './services/payments-service';
import { ProductsService } from './services/products-service';
import { ShipmentService } from './services/shipment-service';

export interface MicroservicesProps {
  vpc: ec2.Vpc;
  appConfig: AppConfig;
}

export class Microservices extends Construct {
  public readonly apiGatewayUrl: string = '';
  public readonly eventBus: sns.Topic;
  public readonly stateMachineArn: string = '';
  public readonly gatewayInvalidationQueueUrl: string = '';

  private ordersLambda?: lambda.IFunction;
  private paymentsLambda?: lambda.IFunction;
  private inventoryLambda?: lambda.IFunction;
  private productsLambda?: lambda.IFunction;
  private shipmentLambda?: lambda.IFunction;

  constructor(scope: Construct, id: string, props: MicroservicesProps) {
    super(scope, id);

    this.eventBus = new sns.Topic(this, 'EventBus', {
      enforceSSL: true,
      displayName: `EventBus-${props.appConfig.deployEnv}`,
      topicName: `EventBus-${props.appConfig.deployEnv}`,
    });

    if (props.appConfig.services.orders) {
      const ordersService = new OrdersService(this, 'OrdersService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.ordersLambda = ordersService.lambda;
    }

    if (props.appConfig.services.products) {
      const productsService = new ProductsService(this, 'ProductsService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.productsLambda = productsService.lambda;
    }

    if (props.appConfig.services.payments) {
      const paymentsService = new PaymentsService(this, 'PaymentsService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.paymentsLambda = paymentsService.lambda;
    }

    if (props.appConfig.services.inventory) {
      const inventoryService = new InventoryService(this, 'InventoryService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.inventoryLambda = inventoryService.lambda;
    }

    if (props.appConfig.services.shipment) {
      const shipmentService = new ShipmentService(this, 'ShipmentService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.shipmentLambda = shipmentService.lambda;
    }

    // Create order saga when all required services are available
    if (
      this.ordersLambda &&
      this.inventoryLambda &&
      this.paymentsLambda &&
      this.shipmentLambda
    ) {
      const saga = new OrderSagaStateMachine(this, 'OrderSagaStateMachine', {
        ordersLambda: this.ordersLambda,
        inventoryLambda: this.inventoryLambda,
        paymentsLambda: this.paymentsLambda,
        shipmentLambda: this.shipmentLambda,
      });
      this.stateMachineArn = saga.stateMachine.stateMachineArn;
    }

    // Gateway cache invalidation queue — receives product.stock_changed from SNS
    const invalidationDlq = new Queue(this, 'GatewayInvalidationDLQ', {
      queueName: `${props.appConfig.deployEnv}-GatewayInvalidationDLQ`,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const invalidationQueue = new Queue(this, 'GatewayInvalidationQueue', {
      queueName: `${props.appConfig.deployEnv}-GatewayInvalidationQueue`,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(30),
      receiveMessageWaitTime: Duration.seconds(5),
      deadLetterQueue: { maxReceiveCount: 5, queue: invalidationDlq },
    });

    this.eventBus.addSubscription(
      new subscriptions.SqsSubscription(invalidationQueue, {
        rawMessageDelivery: true,
        filterPolicy: {
          subject: sns.SubscriptionFilter.stringFilter({
            matchPrefixes: ['product.stock_changed'],
          }),
        },
      })
    );

    invalidationQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [invalidationQueue.queueArn],
        conditions: { ArnEquals: { 'aws:SourceArn': this.eventBus.topicArn } },
      })
    );

    this.gatewayInvalidationQueueUrl = invalidationQueue.queueUrl;

    if (this.anyServiceEnabled(props.appConfig)) {
      const api = new InternalApiGateway(this, 'InternalApiGateway', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        ordersLambda: this.ordersLambda,
        paymentsLambda: this.paymentsLambda,
        inventoryLambda: this.inventoryLambda,
        productsLambda: this.productsLambda,
        shipmentLambda: this.shipmentLambda,
      });
      this.apiGatewayUrl = api.restApi.url;
    }
  }

  private anyServiceEnabled(appConfig: AppConfig) {
    return Object.values(appConfig.services).some((service) => service);
  }
}
