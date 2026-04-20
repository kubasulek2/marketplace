import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSRecord } from 'aws-lambda';
import { createHandler } from '@marketplace/service-handler';

const dynamo = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const httpHandler = async (event: APIGatewayProxyEvent & { action?: string; input?: unknown }): Promise<APIGatewayProxyResult> => {
  const action = event.action ?? 'reserve';
  const productId = 'product-1';

  if (action === 'release') {
    console.log('Compensating: release inventory', event);
    return ok({ action: 'released', productId });
  }

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      productId: { S: productId },
      amount: { N: '1' },
      status: { S: action === 'reserve' ? 'reserved' : 'restocked' },
    },
  }));

  return ok({ action, productId });
};

const queueHandler = async (record: SQSRecord): Promise<void> => {
  console.log('Inventory SQS record:', record.body);
  const body = JSON.parse(record.body) as { subject?: string };
  if (body.subject === 'inventory.restocked') {
    console.log('Processing restock event');
  }
};

export const handler = createHandler(httpHandler, queueHandler);
