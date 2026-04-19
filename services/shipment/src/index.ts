import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent } from 'aws-lambda';

export const handler = async (
  event: APIGatewayProxyEvent | SQSEvent | Record<string, unknown>
): Promise<APIGatewayProxyResult | void> => {
  if ('Records' in event) {
    for (const record of (event as SQSEvent).Records) {
      console.log('Shipment SQS record:', record.body);
    }
    return;
  }
  console.log('Shipment event:', JSON.stringify(event));
  return {
    statusCode: 200,
    body: JSON.stringify({ service: 'shipment', status: 'ok' }),
    headers: { 'Content-Type': 'application/json' },
  };
};
