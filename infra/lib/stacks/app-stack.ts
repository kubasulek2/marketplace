import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { UserPool, UserPoolClient, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { ApiCloudFrontDistribution } from '../constructs/api-cloud-front-distribution';
import { Microservices } from '../constructs/microservices';
import { GatewayEcsService } from '../constructs/services/gateway-service';
import { Waf } from '../constructs/waf';
import { AppConfig, StackEnvConfig } from '../shared/config';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface AppStackProps extends StackProps {
  config: AppConfig;
  env: StackEnvConfig;
  vpc: ec2.Vpc;
  apiDomain: string;
  authDomain: string;
  apiCertificate: acm.ICertificate;
  regionalCertificate: acm.ICertificate;
  logsBucket: s3.Bucket;
  kmsKey: kms.IAlias;
  userPool?: UserPool;
  userPoolClient?: UserPoolClient;
  userPoolDomain?: UserPoolDomain;
}

export class AppStack extends Stack {
  public ssmOriginSecretName: string;
  private originSecret: string;
  private microservices: Microservices;

  constructor(
    scope: Construct,
    id: string,
    private readonly props: AppStackProps
  ) {
    super(scope, id, props);

    this.createOriginSecret();
    this.createMicroservices();
    this.createGatewayService();
    // should be last
    const cf = this.createCloudFrontDistribution();
    this.createWaf(cf.distribution);

    // Display the origin secret
    new CfnOutput(this, 'OriginSecret', {
      value: this.originSecret,
      description: 'Origin secret for the API',
    });

    // Add common tags to all resources in the stack
    Tags.of(this).add('Project', props.config.project);
    Tags.of(this).add('Environment', props.config.deployEnv);
  }

  private createOriginSecret() {
    // replace this later with uuid()
    this.originSecret = '8b3e6f0d-c09e-4f69-ba72-370855dbc430';
    this.ssmOriginSecretName = `/${this.props.config.project}/${this.props.config.deployEnv}/api/origin-secret`;

    new ssm.StringParameter(this, 'SsmOriginSecret', {
      parameterName: this.ssmOriginSecretName,
      stringValue: this.originSecret,
      description: 'Origin secret for the API',
    });
  }

  private createGatewayService() {
    return new GatewayEcsService(this, getEnvSpecificName('GatewayEcsCluster'), {
      vpc: this.props.vpc,
      certificate: this.props.regionalCertificate,
      kmsKey: this.props.kmsKey,
      config: this.props.config,
      originSecret: this.originSecret,
      userPool: this.props.userPool,
      userPoolClient: this.props.userPoolClient,
      userPoolDomain: this.props.userPoolDomain,
      apiGatewayUrl: this.microservices.apiGatewayUrl,
      eventBus: this.microservices.eventBus,
    });
  }

  private createCloudFrontDistribution() {
    return new ApiCloudFrontDistribution(this, getEnvSpecificName('ApiDistribution'), {
      loadBalancerDomain: GatewayEcsService.loadBalancerDnsName,
      certificate: this.props.apiCertificate,
      domainNames: [this.props.apiDomain],
      originSecret: this.originSecret,
      logsBucket: this.props.logsBucket,
      authDomain: this.props.authDomain,
      authClientId: this.props.userPoolClient?.userPoolClientId,
      apiDomain: this.props.apiDomain,
      deployEnv: this.props.config.deployEnv,
    });
  }

  private createWaf(distribution: Distribution) {
    if (!this.props.config.useAuth) {
      return;
    }
    return new Waf(this, getEnvSpecificName('WAF'), {
      distribution,
    });
  }

  private createMicroservices() {
    this.microservices = new Microservices(this, getEnvSpecificName('Microservices'), {
      vpc: this.props.vpc,
      appConfig: this.props.config,
    });

    return this.microservices;
  }
}
