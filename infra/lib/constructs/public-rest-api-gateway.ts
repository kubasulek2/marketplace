import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { AppEnvironment } from '../shared/types';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';
import * as iam from 'aws-cdk-lib/aws-iam';
export interface PublicRestApiGatewayProps {
  environment: AppEnvironment;
  originSecret: string;
}

export class PublicRestApiGateway extends Construct {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: PublicRestApiGatewayProps) {
    super(scope, id);

    // Create response parameters that will be reused across methods
    const corsResponseParameters = {
      'method.response.header.Access-Control-Allow-Origin': true,
      'method.response.header.Access-Control-Allow-Methods': true,
      'method.response.header.Access-Control-Allow-Headers': true,
    };

    const corsIntegrationResponseParameters = {
      'method.response.header.Access-Control-Allow-Origin': "'*'",
      'method.response.header.Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS,PATCH'",
      'method.response.header.Access-Control-Allow-Headers':
        "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
    };

    this.api = new apigateway.RestApi(this, getEnvSpecificName('PublicRestApi'), {
      restApiName: `Public REST API - ${props.environment}`,
      description: `Public REST API Gateway for the ${props.environment} environment`,
      deployOptions: {
        stageName: props.environment,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowCredentials: true,
      },
      policy: new iam.PolicyDocument({
        statements: [
          // Deny all requests NOT having the correct header
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringNotEquals: {
                'aws:RequestHeader/X-Origin-Secret': props.originSecret,
              },
            },
          }),
          // Allow requests that were not denied
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
          }),
        ],
      }),
    });

    // Add test endpoint
    const test = this.api.root.addResource('test');
    test.addMethod(
      'GET',
      new apigateway.MockIntegration({
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': JSON.stringify({
                status: 200,
                message: 'ok',
              }),
            },
            responseParameters: corsIntegrationResponseParameters,
          },
        ],
        requestTemplates: {
          'application/json': '{ "statusCode": 200 }',
        },
      }),
      {
        methodResponses: [
          {
            statusCode: '200',
            responseParameters: corsResponseParameters,
            responseModels: {
              'application/json': apigateway.Model.EMPTY_MODEL,
            },
          },
        ],
      }
    );

    // Add custom gateway responses for common error cases
    this.api.addGatewayResponse('UNAUTHORIZED', {
      type: apigateway.ResponseType.UNAUTHORIZED,
      statusCode: '401',
      responseHeaders: corsIntegrationResponseParameters,
      templates: {
        'application/json': JSON.stringify({
          message: 'Unauthorized',
          statusCode: 401,
          timestamp: '$context.requestTime',
          requestId: '$context.requestId',
        }),
      },
    });

    this.api.addGatewayResponse('FORBIDDEN', {
      type: apigateway.ResponseType.ACCESS_DENIED,
      statusCode: '403',
      responseHeaders: corsIntegrationResponseParameters,
      templates: {
        'application/json': JSON.stringify({
          message: 'Forbidden',
          statusCode: 403,
          timestamp: '$context.requestTime',
          requestId: '$context.requestId',
        }),
      },
    });

    this.api.addGatewayResponse('MISSING_AUTH_TOKEN', {
      type: apigateway.ResponseType.RESOURCE_NOT_FOUND,
      statusCode: '404',
      responseHeaders: corsIntegrationResponseParameters,
      templates: {
        'application/json': JSON.stringify({
          message: 'Route not found',
          statusCode: 404,
          timestamp: '$context.requestTime',
          requestId: '$context.requestId',
        }),
      },
    });

    this.api.addGatewayResponse('NOT_FOUND', {
      type: apigateway.ResponseType.RESOURCE_NOT_FOUND,
      statusCode: '404',
      responseHeaders: corsIntegrationResponseParameters,
      templates: {
        'application/json': JSON.stringify({
          message: 'Resource not found',
          statusCode: 404,
          timestamp: '$context.requestTime',
          requestId: '$context.requestId',
        }),
      },
    });
  }
}
