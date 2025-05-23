import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { UserPool, UserPoolClient, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { v4 as uuid } from 'uuid';

import { ApiCloudFrontDistribution } from '../constructs/api-cloud-front-distribution';
import { GatewayEcsService } from '../constructs/services/gateway-service';
import { AppConfig, StackEnvConfig } from '../shared/config';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';
import { NetworkStack } from '../stacks/network-stack';

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
  public readonly ssmOriginSecretName: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const originSecret = uuid();

    this.ssmOriginSecretName = `/${props.config.project}/${props.config.deployEnv}/api/origin-secret`;

    new ssm.StringParameter(this, 'SsmOriginSecret', {
      parameterName: this.ssmOriginSecretName,
      stringValue: originSecret,
      description: 'Origin secret for the API',
    });

    const gatewayEcsCluster = new GatewayEcsService(this, getEnvSpecificName('GatewayEcsCluster'), {
      vpc: props.vpc,
      certificate: props.regionalCertificate,
      kmsKey: props.kmsKey,
      config: props.config,
      originSecret,
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      userPoolDomain: props.userPoolDomain,
    });

    const distribution = new ApiCloudFrontDistribution(
      this,
      getEnvSpecificName('ApiDistribution'),
      {
        loadBalancerDomain: gatewayEcsCluster.loadBalancerDnsName,
        certificate: props.apiCertificate,
        domainNames: [props.apiDomain],
        originSecret,
        logsBucket: props.logsBucket,
        authDomain: props.authDomain,
        authClientId: props.userPoolClient?.userPoolClientId,
      }
    );

    // Create a Route 53 record for the API CloudFront distribution
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: NetworkStack.domain,
    });

    new route53.ARecord(this, 'ApiRecord', {
      comment: `API CloudFront Distribution ${props.config.deployEnv}`,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new CloudFrontTarget(distribution.distribution)),
      recordName: props.apiDomain,
      deleteExisting: true,
    });

    // Invalidate the CloudFront distribution when the app is updated
    const invalidation = new cr.AwsCustomResource(this, 'CloudFrontInvalidation', {
      onCreate: {
        service: 'CloudFront',
        action: 'createInvalidation',
        parameters: {
          DistributionId: distribution.distribution.distributionId,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Quantity: 1,
              Items: ['/*'],
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    invalidation.node.addDependency(distribution.distribution);

    // Display the origin secret
    new CfnOutput(this, 'OriginSecret', {
      value: originSecret,
      description: 'Origin secret for the API',
    });

    // Add common tags to all resources in the stack
    Tags.of(this).add('Project', props.config.project);
    Tags.of(this).add('Environment', props.config.deployEnv);
  }
}
