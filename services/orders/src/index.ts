import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent } from 'aws-lambda';

export const handler = async (
  event: APIGatewayProxyEvent | SQSEvent | Record<string, unknown>
): Promise<APIGatewayProxyResult | void> => {
  if ('Records' in event) {
    for (const record of (event as SQSEvent).Records) {
      console.log('Orders SQS record:', record.body);
    }
    return;
  }
  console.log('Orders event:', JSON.stringify(event));
  return {
    statusCode: 200,
    body: JSON.stringify({ service: 'orders', status: 'ok' }),
    headers: { 'Content-Type': 'application/json' },
  };
};
