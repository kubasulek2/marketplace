import { Stack, StackProps, Tags, Fn, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DeploymentContext } from '../shared/types';

export interface NetworkStackProps extends StackProps {
  context: DeploymentContext;
}

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const vpcName = `${props.context.project}-${props.context.environment}-vpc`;

    // Create VPC with 2 public and 2 private subnets
    this.vpc = new ec2.Vpc(this, 'MarketplaceVPC', {
      maxAzs: 2, // Use 2 Availability Zones
      vpcName,
      ipAddresses: ec2.IpAddresses.cidr('10.231.0.0/16'),

      // Define subnet configuration
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],

      // Enable DNS hostnames and DNS support
      enableDnsHostnames: true,
      enableDnsSupport: true,

      // Create gateway endpoints for S3 and DynamoDB
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
        DynamoDB: {
          service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        },
      },

      // Create a NAT Gateway for private subnets
      natGateways: 1, // 2 for high availability
    });

    // Add tags to all subnets
    this.vpc.publicSubnets.forEach((subnet, index) => {
      Tags.of(subnet).add(
        'Name',
        `${props.context.project}-${props.context.environment}-public-subnet-${index + 1}`
      );
    });

    this.vpc.privateSubnets.forEach((subnet, index) => {
      Tags.of(subnet).add(
        'Name',
        `${props.context.project}-${props.context.environment}-private-subnet-${index + 1}`
      );
    });

    // Add common tags to all resources in the stack
    Tags.of(this).add('Project', props.context.project);
    Tags.of(this).add('Environment', props.context.environment);

    // VPC Flow Logs
    const logsBucket = new s3.Bucket(this, 'VPCFlowLogsBucket', {
      bucketName: `${props.context.project}-${props.context.environment}-vpc-flow-logs`,
      versioned: true,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Add bucket policy instead of IAM role
    const bucketPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [logsBucket.arnForObjects(`AWSLogs/${Stack.of(this).account}/*`)],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': Stack.of(this).account,
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:*`,
        },
      },
    });

    const bucketAclPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [logsBucket.bucketArn],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': Stack.of(this).account,
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:*`,
        },
      },
    });

    logsBucket.addToResourcePolicy(bucketPolicy);
    logsBucket.addToResourcePolicy(bucketAclPolicy);

    const flowLogs = new ec2.FlowLog(this, 'VPCFlowLogs', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toS3(logsBucket, undefined, {
        fileFormat: ec2.FlowLogFileFormat.PARQUET,
      }),
      flowLogName: `${props.context.project}-${props.context.environment}-vpc-flow-logs`,
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
  }
}
