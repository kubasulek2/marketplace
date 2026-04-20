import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSRecord } from 'aws-lambda';
import { createHandler } from '@marketplace/service-handler';

const dynamo = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const httpHandler = async (event: APIGatewayProxyEvent & { action?: string; input?: unknown }): Promise<APIGatewayProxyResult> => {
  const orderId = (event.input as { orderId?: string })?.orderId ?? 'unknown';
  const shipmentId = `shipment-${Date.now()}`;

  await dynamo.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      shipmentId: { S: shipmentId },
      orderId: { S: orderId },
      status: { S: 'dispatched' },
      createdAt: { S: new Date().toISOString() },
    },
  }));

  return ok({ action: 'created', shipmentId, orderId });
};

const queueHandler = async (record: SQSRecord): Promise<void> => {
  console.log('Shipment SQS record:', record.body);
};

export const handler = createHandler(httpHandler, queueHandler);
