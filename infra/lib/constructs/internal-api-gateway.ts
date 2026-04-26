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
  ordersLambda?: lambda.IFunction;
  paymentsLambda?: lambda.IFunction;
  inventoryLambda?: lambda.IFunction;
  productsLambda?: lambda.IFunction;
  shipmentLambda?: lambda.IFunction;
}

export class InternalApiGateway extends Construct {
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: InternalApiGatewayProps) {
    super(scope, id);

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
        tracingEnabled: true,
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

    if (props.ordersLambda) {
      this.addIntegration('orders', props.ordersLambda);
    }
    if (props.paymentsLambda) {
      this.addIntegration('payments', props.paymentsLambda);
    }
    if (props.inventoryLambda) {
      const integration = new apigateway.LambdaIntegration(props.inventoryLambda);
      const resource = this.restApi.root.addResource('inventory');
      resource.addMethod('ANY', integration);
      resource.addResource('{id}').addMethod('ANY', integration);
    }
    if (props.productsLambda) {
      this.addProductsIntegration(props.productsLambda);
    }
    if (props.shipmentLambda) {
      this.addIntegration('shipments', props.shipmentLambda);
    }

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.restApi.url,
      description: 'Internal API Gateway URL',
    });
  }

  private addIntegration(resourcePath: string, handler: lambda.IFunction) {
    const resource = this.restApi.root.addResource(resourcePath);
    resource.addMethod('ANY', new apigateway.LambdaIntegration(handler));
  }

  private addProductsIntegration(handler: lambda.IFunction) {
    const integration = new apigateway.LambdaIntegration(handler);
    const resource = this.restApi.root.addResource('products');
    resource.addMethod('ANY', integration);
    // Support GET /products/{id}
    resource.addResource('{id}').addMethod('ANY', integration);
  }
}
