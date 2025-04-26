import { Stack, StackProps, Tags } from 'aws-cdk-lib';
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
import { v4 as uuid } from 'uuid';

export interface AppStackProps extends StackProps {
  context: DeploymentContext;
  vpc: ec2.Vpc;
  apiDnsRecord: string;
  authDnsRecord: string;
  apiCertificate: acm.ICertificate;
  authCertificate: acm.ICertificate;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const originSecret = uuid();

    const api = new PublicRestApiGateway(this, getEnvSpecificName('PublicApi'), {
      environment: props.context.environment,
      originSecret,
    });

    const distribution = new ApiCloudFrontDistribution(
      this,
      getEnvSpecificName('ApiDistribution'),
      {
        apiGateway: api.api,
        certificate: props.apiCertificate,
        domainNames: [props.apiDnsRecord],
        originSecret,
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
      recordName: props.apiDnsRecord,
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

    // Add common tags to all resources in the stack
    Tags.of(this).add('Project', props.context.project);
    Tags.of(this).add('Environment', props.context.environment);
  }
}
