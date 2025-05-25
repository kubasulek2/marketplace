import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

import { AppConfig } from '../shared/config';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface InternalApiGatewayProps {
  vpc: ec2.Vpc;
  appConfig: AppConfig;
  ordersLambda?: lambda.Function;
  paymentsLambda?: lambda.Function;
  inventoryLambda?: lambda.Function;
}

export class InternalApiGateway extends Construct {
  public readonly stageUrl: string;

  private api: apigatewayv2.HttpApi;

  constructor(scope: Construct, id: string, props: InternalApiGatewayProps) {
    super(scope, id);

    const isProd = props.appConfig.deployEnv === 'prod';
    // use vpc endpoint

    this.api = new apigatewayv2.HttpApi(this, 'InternalHttpApi', {
      apiName: getEnvSpecificName('InternalApiGateway'),
      createDefaultStage: isProd,
    });

    if (isProd) {
      this.stageUrl = this.api.apiEndpoint; // e.g. https://xyz.execute-api.us-east-1.amazonaws.com
    } else {
      new apigatewayv2.HttpStage(this, 'DevStage', {
        httpApi: this.api,
        stageName: props.appConfig.deployEnv,
        autoDeploy: true,
      });
      // e.g. https://xyz.execute-api.us-east-1.amazonaws.com/dev
      this.stageUrl = `${this.api.apiEndpoint}/${props.appConfig.deployEnv}`;
    }

    if (props.ordersLambda) {
      this.addIntegration('/orders', props.ordersLambda);
    }

    if (props.paymentsLambda) {
      this.addIntegration('/payments', props.paymentsLambda);
    }

    if (props.inventoryLambda) {
      this.addIntegration('/inventory', props.inventoryLambda);
    }

    // const vpcEndpoint = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    // this.api.addVpcLink({
    //   vpc: props.vpc,
    //   subnets: vpcEndpoint,
    // });
  }

  private addIntegration(path: string, handler: lambda.Function) {
    this.api.addRoutes({
      path,
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration(`${path}Integration`, handler),
    });
    // Allow this specific API Gateway to invoke the Lambda
    handler.addPermission(`${path}InvokePermission`, {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.api.arnForExecuteApi(), // Scopes permission to this API
    });
  }
}
