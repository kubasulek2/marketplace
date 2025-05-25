import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
  public readonly apiGatewayUrl?: string;

  private ordersLambda?: lambda.Function;
  private paymentsLambda?: lambda.Function;
  private inventoryLambda?: lambda.Function;

  constructor(scope: Construct, id: string, props: MicroservicesProps) {
    super(scope, id);

    // orders service
    if (props.appConfig.services.orders) {
      const ordersService = new OrdersService(this, 'OrdersService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
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
      });
      this.paymentsLambda = paymentsService.lambda;
    }

    // inventory service
    if (props.appConfig.services.inventory) {
      const inventoryService = new InventoryService(this, 'InventoryService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
      });
      this.inventoryLambda = inventoryService.lambda;
    }

    // internal api gateway
    if (this.anyServiceEnabled(props.appConfig)) {
      this.apiGatewayUrl = new InternalApiGateway(this, 'InternalApiGateway', {
        vpc: props.vpc,
        appConfig: props.appConfig,
        ordersLambda: this.ordersLambda,
        paymentsLambda: this.paymentsLambda,
        inventoryLambda: this.inventoryLambda,
      }).stageUrl;
    }
  }

  private anyServiceEnabled(appConfig: AppConfig) {
    return Object.values(appConfig.services).some((service) => service);
  }
}
