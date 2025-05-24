import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

import { AppConfig } from '../shared/config';

import { InventoryService } from './services/inventory-service';
import { OrdersService } from './services/orders-service';
import { PaymentsService } from './services/payments-service';

export interface MicroservicesProps {
  vpc: ec2.Vpc;
  appConfig: AppConfig;
}

export class Microservices extends Construct {
  constructor(scope: Construct, id: string, props: MicroservicesProps) {
    super(scope, id);

    // orders service
    if (props.appConfig.services.orders) {
      new OrdersService(this, 'OrdersService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
      });
    }

    // products service
    if (props.appConfig.services.products) {
      // TODO: add products service
    }

    // payments service
    if (props.appConfig.services.payments) {
      new PaymentsService(this, 'PaymentsService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
      });
    }

    // inventory service
    if (props.appConfig.services.inventory) {
      new InventoryService(this, 'InventoryService', {
        vpc: props.vpc,
        appConfig: props.appConfig,
      });
    }

    // internal api gateway
  }
}
