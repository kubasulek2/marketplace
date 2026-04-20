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

function invoke(scope: Construct, id: string, fn: lambda.IFunction, action: string, resultPath: string) {
  return new tasks.LambdaInvoke(scope, id, {
    lambdaFunction: fn,
    payload: sfn.TaskInput.fromObject({
      action,
      'input.$': '$',
    }),
    payloadResponseOnly: true, // unwrap Lambda result directly, skip SDK envelope
    resultPath,
  });
}

export class OrderSagaStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: OrderSagaStateMachineProps) {
    super(scope, id);

    const succeed = new sfn.Succeed(this, 'OrderSucceeded');
    const fail = new sfn.Fail(this, 'OrderFailed', {
      error: 'OrderFailed',
      cause: 'Order saga failed and was compensated',
    });

    // Compensation chain — built bottom-up so each step chains to the next
    const cancelOrder = invoke(this, 'CancelOrder', props.ordersLambda, 'cancel', '$.compensationResult').next(fail);
    const releaseInventory = invoke(this, 'ReleaseInventory', props.inventoryLambda, 'release', '$.compensationResult').next(cancelOrder);
    const refundPayment = invoke(this, 'RefundPayment', props.paymentsLambda, 'refund', '$.compensationResult').next(releaseInventory);

    // Happy path
    const placeOrder = invoke(this, 'PlaceOrder', props.ordersLambda, 'place', '$.placeOrderResult');
    const reserveInventory = invoke(this, 'ReserveInventory', props.inventoryLambda, 'reserve', '$.reserveInventoryResult');
    const chargePayment = invoke(this, 'ChargePayment', props.paymentsLambda, 'charge', '$.chargePaymentResult');
    const createShipment = invoke(this, 'CreateShipment', props.shipmentLambda, 'create', '$.createShipmentResult');

    placeOrder.addCatch(cancelOrder, { resultPath: '$.error' });
    reserveInventory.addCatch(cancelOrder, { resultPath: '$.error' });
    chargePayment.addCatch(releaseInventory, { resultPath: '$.error' });
    createShipment.addCatch(refundPayment, { resultPath: '$.error' });

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
