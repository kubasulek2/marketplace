import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { AppConfig } from '../shared/config';
import { vpcEndpointId } from '../shared/exports';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface InternalApiGatewayProps {
  vpc: ec2.Vpc;
  appConfig: AppConfig;
  ordersLambda?: lambda.Function;
  paymentsLambda?: lambda.Function;
  inventoryLambda?: lambda.Function;
}

export class InternalApiGateway extends Construct {
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: InternalApiGatewayProps) {
    super(scope, id);

    // Create the REST API
    this.restApi = new apigateway.RestApi(this, 'InternalRestApi', {
      restApiName: getEnvSpecificName('InternalApiGateway'),
      description: `Internal API Gateway for the ${props.appConfig.deployEnv} environment`,
      endpointConfiguration: props.appConfig.usePrivateSubnets
        ? {
            types: [apigateway.EndpointType.PRIVATE],
            vpcEndpoints: [
              ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(this, 'VpcEndpoint', {
                vpcEndpointId: cdk.Fn.importValue(vpcEndpointId),
                port: 443,
              }),
            ],
          }
        : {
            types: [apigateway.EndpointType.REGIONAL],
          },
      deployOptions: {
        stageName: props.appConfig.deployEnv,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'AccessLogGroup', {
            logGroupName: `/aws/apigateway/internal-api/${props.appConfig.deployEnv}/access`,
            retention: 30,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    if (props.appConfig.usePrivateSubnets) {
      this.restApi.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          resources: ['*'],

          conditions: {
            StringEquals: {
              'aws:SourceVpce': cdk.Fn.importValue(vpcEndpointId),
            },
          },
        })
      );
    }

    // Add integrations
    if (props.ordersLambda) {
      this.addIntegration('/orders', props.ordersLambda);
    }
    if (props.paymentsLambda) {
      this.addIntegration('/payments', props.paymentsLambda);
    }
    if (props.inventoryLambda) {
      this.addIntegration('/inventory', props.inventoryLambda);
    }

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.restApi.url,
      description: 'Internal API Gateway URL',
    });
  }

  private addIntegration(path: string, handler: lambda.Function) {
    const resource = this.restApi.root.resourceForPath(path);
    const integration = new apigateway.LambdaIntegration(handler);

    resource.addMethod('ANY', integration);
  }
}
