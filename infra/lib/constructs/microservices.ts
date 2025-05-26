import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { AppConfig } from '../shared/config';

import { InternalApiGateway } from './internal-api-gateway';
import { InventoryService } from './services/inventory-service';
import { OrdersService } from './services/orders-service';
import { PaymentsService } from './services/payments-service';

export interface MicroservicesProps {
  vpc: ec2.Vpc;
  appConfig: AppConfig;
}

export class Microservices extends Construct {
  public readonly apiGatewayUrl: string = '';
  public readonly eventBus: sns.Topic;

  private ordersLambda?: lambda.Function;
  private paymentsLambda?: lambda.Function;
  private inventoryLambda?: lambda.Function;

  constructor(scope: Construct, id: string, props: MicroservicesProps) {
    super(scope, id);

    this.eventBus = new sns.Topic(this, 'EventBus', {
      enforceSSL: true,
      displayName: `EventBus-${props.appConfig.deployEnv}`,
      topicName: `EventBus-${props.appConfig.deployEnv}`,
      // masterKey: 'my-key' // TODO: provide my own key
      // tracingConfig: sns.TracingConfig.ACTIVE, // for X-Ray
    });

    // orders service
    if (props.appConfig.services.orders) {
      const ordersService = new OrdersService(this, 'OrdersService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.ordersLambda = ordersService.lambda;
    }

    // products service
    if (props.appConfig.services.products) {
      // TODO: add products service
    }

    // payments service
    if (props.appConfig.services.payments) {
      const paymentsService = new PaymentsService(this, 'PaymentsService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.paymentsLambda = paymentsService.lambda;
    }

    // inventory service
    if (props.appConfig.services.inventory) {
      const inventoryService = new InventoryService(this, 'InventoryService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        eventBus: this.eventBus,
      });
      this.inventoryLambda = inventoryService.lambda;
    }

    // internal api gateway
    if (this.anyServiceEnabled(props.appConfig)) {
      const api = new InternalApiGateway(this, 'InternalApiGateway', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        ordersLambda: this.ordersLambda,
        paymentsLambda: this.paymentsLambda,
        inventoryLambda: this.inventoryLambda,
      });
      this.apiGatewayUrl = api.restApi.url;
    }
  }

  private anyServiceEnabled(appConfig: AppConfig) {
    return Object.values(appConfig.services).some((service) => service);
  }
}
