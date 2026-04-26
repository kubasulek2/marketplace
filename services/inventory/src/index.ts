import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSRecord } from 'aws-lambda';
import { createHandler } from '@marketplace/service-handler';

const dynamo = new DynamoDBClient({});
const sns = new SNSClient({});
const TABLE = process.env.TABLE_NAME ?? '';
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? '';

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function publishStockChanged(productId: string) {
  if (!EVENT_BUS_URL) return;
  await sns.send(new PublishCommand({
    TopicArn: EVENT_BUS_URL,
    Message: JSON.stringify({ productId }),
    Subject: 'product.stock_changed',
  }));
}

const httpHandler = async (event: APIGatewayProxyEvent & { action?: string }): Promise<APIGatewayProxyResult> => {
  const action = event.action ?? 'reserve';
  const productId = event.pathParameters?.id ?? 'product-1';

  if (action === 'release') {
    console.log('Compensating: release inventory');
    await publishStockChanged(productId);
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

  await publishStockChanged(productId);
  return ok({ action, productId });
};

const queueHandler = async (record: SQSRecord): Promise<void> => {
  console.log('Inventory SQS record:', record.body);
  const body = JSON.parse(record.body) as { subject?: string; productId?: string };
  if (body.subject === 'inventory.restocked' && body.productId) {
    await publishStockChanged(body.productId);
  }
};

export const handler = createHandler(httpHandler, queueHandler);
