import { CfnOutput, Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { NetworkStack } from '../stacks/network-stack';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { DeploymentContext } from '../shared/types';
import { PublicRestApiGateway } from '../constructs/public-rest-api-gateway';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';
import { ApiCloudFrontDistribution } from '../constructs/api-cloud-front-distribution';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { v4 as uuid } from 'uuid';
import { GatewayEcsCluster } from '../constructs/gateway-ecs-cluster';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
import { UserPool } from 'aws-cdk-lib/aws-cognito';

export interface AppStackProps extends StackProps {
  context: DeploymentContext;
  vpc: ec2.Vpc;
  apiDomain: string;
  authDomain: string;
  apiCertificate: acm.ICertificate;
  regionalCertificate: acm.ICertificate;
  logsBucket: s3.Bucket;
  kmsKey: kms.IAlias;
  userPool: UserPool;
}

export class AppStack extends Stack {
  public readonly ssmOriginSecretName: string;
  public readonly restApi: RestApi;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const originSecret = uuid();

    this.ssmOriginSecretName = `/${props.context.project}/${props.context.environment}/api/origin-secret`;

    new ssm.StringParameter(this, 'SsmOriginSecret', {
      parameterName: this.ssmOriginSecretName,
      stringValue: originSecret,
      description: 'Origin secret for the API',
    });

    const gatewayEcsCluster = new GatewayEcsCluster(this, getEnvSpecificName('GatewayEcsCluster'), {
      vpc: props.vpc,
      certificate: props.regionalCertificate,
      kmsKey: props.kmsKey,
      context: props.context,
    });

    const api = new PublicRestApiGateway(this, getEnvSpecificName('PublicApi'), {
      environment: props.context.environment,
      originSecret,
      vpc: props.vpc,
      loadBalancerDnsName: gatewayEcsCluster.loadBalancerDnsName,
      userPool: props.userPool,
    });

    this.restApi = api.api;

    const distribution = new ApiCloudFrontDistribution(
      this,
      getEnvSpecificName('ApiDistribution'),
      {
        apiGateway: api.api,
        certificate: props.apiCertificate,
        domainNames: [props.apiDomain],
        originSecret,
        logsBucket: props.logsBucket,
      }
    );

    // Create a Route 53 record for the API CloudFront distribution
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: NetworkStack.domain,
    });

    new route53.ARecord(this, 'ApiRecord', {
      comment: `API CloudFront Distribution ${props.context.environment}`,
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
    Tags.of(this).add('Project', props.context.project);
    Tags.of(this).add('Environment', props.context.environment);
  }
}
