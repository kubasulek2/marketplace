import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSRecord } from 'aws-lambda';
import { createHandler } from '@marketplace/service-handler';

const dynamo = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const httpHandler = async (event: APIGatewayProxyEvent & { action?: string; input?: unknown }): Promise<APIGatewayProxyResult> => {
  const action = event.action ?? 'place';
  const orderId = `order-${Date.now()}`;
  const userId = 'user-1';

  if (action === 'cancel') {
    console.log('Compensating: cancel order', event);
    return ok({ action: 'cancelled', orderId });
  }

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      userId: { S: userId },
      orderId: { S: orderId },
      status: { S: 'placed' },
      createdAt: { S: new Date().toISOString() },
    },
  }));

  return ok({ action: 'placed', orderId, userId });
};

const queueHandler = async (record: SQSRecord): Promise<void> => {
  console.log('Orders SQS record:', record.body);
};

export const handler = createHandler(httpHandler, queueHandler);
