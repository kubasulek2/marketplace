import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent, SQSRecord } from 'aws-lambda';

type HttpHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
type QueueHandler = (record: SQSRecord) => Promise<void>;
type LambdaEvent = APIGatewayProxyEvent | SQSEvent | Record<string, unknown>;

export const createHandler = (http: HttpHandler, queue: QueueHandler) =>
  async (event: LambdaEvent): Promise<APIGatewayProxyResult | void> => {
    if ('Records' in event) {
      for (const record of (event as SQSEvent).Records) {
        await queue(record);
      }
      return;
    }
    return http(event as APIGatewayProxyEvent);
  };
