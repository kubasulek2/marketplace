import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSRecord } from 'aws-lambda';
import { createHandler } from '@marketplace/service-handler';

const dynamo = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const httpHandler = async (event: APIGatewayProxyEvent & { action?: string; input?: unknown }): Promise<APIGatewayProxyResult> => {
  const action = event.action ?? 'charge';
  const paymentId = `payment-${Date.now()}`;
  const orderId = (event.input as { orderId?: string })?.orderId ?? 'unknown';

  if (action === 'refund') {
    console.log('Compensating: refund payment', event);
    return ok({ action: 'refunded', paymentId, orderId });
  }

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      paymentId: { S: paymentId },
      orderId: { S: orderId },
      amount: { N: '0' },
      status: { S: 'charged' },
    },
  }));

  return ok({ action: 'charged', paymentId, orderId });
};

const queueHandler = async (record: SQSRecord): Promise<void> => {
  console.log('Payments SQS record:', record.body);
};

export const handler = createHandler(httpHandler, queueHandler);
