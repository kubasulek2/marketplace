import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface OrderSagaStateMachineProps {
  ordersLambda: lambda.IFunction;
  inventoryLambda: lambda.IFunction;
  paymentsLambda: lambda.IFunction;
  shipmentLambda: lambda.IFunction;
}

export class OrderSagaStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: OrderSagaStateMachineProps) {
    super(scope, id);

    // Terminal states
    const succeed = new sfn.Succeed(this, 'OrderSucceeded');
    const fail = new sfn.Fail(this, 'OrderFailed', {
      error: 'OrderFailed',
      cause: 'Order saga failed and was compensated',
    });

    // Compensation chain (built bottom-up so each step can chain to the next)
    const cancelOrder = new tasks.LambdaInvoke(this, 'CancelOrder', {
      lambdaFunction: props.ordersLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'cancel',
        'input.$': '$',
      }),
      resultPath: '$.compensationResult',
    }).next(fail);

    const releaseInventory = new tasks.LambdaInvoke(this, 'ReleaseInventory', {
      lambdaFunction: props.inventoryLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'release',
        'input.$': '$',
      }),
      resultPath: '$.compensationResult',
    }).next(cancelOrder);

    const refundPayment = new tasks.LambdaInvoke(this, 'RefundPayment', {
      lambdaFunction: props.paymentsLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'refund',
        'input.$': '$',
      }),
      resultPath: '$.compensationResult',
    }).next(releaseInventory);

    // Forward states
    const placeOrder = new tasks.LambdaInvoke(this, 'PlaceOrder', {
      lambdaFunction: props.ordersLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'place',
        'input.$': '$',
      }),
      resultPath: '$.placeOrderResult',
    });

    const reserveInventory = new tasks.LambdaInvoke(this, 'ReserveInventory', {
      lambdaFunction: props.inventoryLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'reserve',
        'input.$': '$',
      }),
      resultPath: '$.reserveInventoryResult',
    });

    const chargePayment = new tasks.LambdaInvoke(this, 'ChargePayment', {
      lambdaFunction: props.paymentsLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'charge',
        'input.$': '$',
      }),
      resultPath: '$.chargePaymentResult',
    });

    const createShipment = new tasks.LambdaInvoke(this, 'CreateShipment', {
      lambdaFunction: props.shipmentLambda,
      payload: sfn.TaskInput.fromObject({
        action: 'create',
        'input.$': '$',
      }),
      resultPath: '$.createShipmentResult',
    });

    // Wire compensation catches
    placeOrder.addCatch(cancelOrder, { resultPath: '$.error' });
    reserveInventory.addCatch(cancelOrder, { resultPath: '$.error' });
    chargePayment.addCatch(releaseInventory, { resultPath: '$.error' });
    createShipment.addCatch(refundPayment, { resultPath: '$.error' });

    // Happy path chain
    const definition = placeOrder
      .next(reserveInventory)
      .next(chargePayment)
      .next(createShipment)
      .next(succeed);

    this.stateMachine = new sfn.StateMachine(this, getEnvSpecificName('OrderSagaStateMachine'), {
      stateMachineName: getEnvSpecificName('OrderSagaStateMachine'),
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.EXPRESS,
      timeout: Duration.minutes(5),
    });
  }

  grantStartSyncExecution(grantee: iam.IGrantable) {
    return this.stateMachine.grantStartSyncExecution(grantee);
  }
}
