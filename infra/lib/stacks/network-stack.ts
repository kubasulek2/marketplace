import { Stack, StackProps, Tags, Fn, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { AppEnvironment, DeploymentContext } from '../shared/types';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

type CertMapping = {
  [key in AppEnvironment]: {
    api: string;
    auth: string;
  };
};

export interface NetworkStackProps extends StackProps {
  context: DeploymentContext;
}

export class NetworkStack extends Stack {
  public static readonly domain = 'kuba-bright.com';
  private readonly certMapping: CertMapping = {
    dev: {
      api: 'arn:aws:acm:us-east-1:536697237982:certificate/312f7793-1480-4dda-8091-4cb10e26e761',
      auth: 'arn:aws:acm:us-east-1:536697237982:certificate/7e068d81-2374-4ef3-a67e-82fd62ef1541',
    },
    prod: {
      api: 'arn:aws:acm:us-east-1:536697237982:certificate/aae4aa96-0391-415e-8633-0ac46705ef93',
      auth: 'arn:aws:acm:us-east-1:536697237982:certificate/7570dd87-e9e9-4691-97e2-a6d7367b93ee',
    },
  };
  public readonly vpc: ec2.Vpc;
  public readonly apiDnsRecord: string;
  public readonly authDnsRecord: string;
  public readonly apiCertificate: acm.ICertificate;
  public readonly authCertificate: acm.ICertificate;
  public readonly kmsKey: kms.IAlias;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.kmsKey = kms.Alias.fromAliasName(this, 'KMSKey', 'alias/marketplace-key');

    this.apiDnsRecord = this.getDnsRecord('api', props.context.environment);
    this.authDnsRecord = this.getDnsRecord('auth', props.context.environment);

    // Import existing API certificate
    this.apiCertificate = acm.Certificate.fromCertificateArn(
      this,
      getEnvSpecificName('api-certificate'),
      this.certMapping[props.context.environment].api
    );

    // Import existing Auth certificate
    this.authCertificate = acm.Certificate.fromCertificateArn(
      this,
      getEnvSpecificName('auth-certificate'),
      this.certMapping[props.context.environment].auth
    );

    const vpcName = getEnvSpecificName('vpc');

    // Create VPC with 2 public and 2 private subnets
    this.vpc = new ec2.Vpc(this, vpcName, {
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

    // VPC Flow Logs
    const logsBucket = new s3.Bucket(this, getEnvSpecificName('vpc-flow-logs-bucket'), {
      bucketName: getEnvSpecificName(`vpc-flow-logs-${this.account}`),
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
      resources: [logsBucket.arnForObjects(`AWSLogs/${this.account}/*`)],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:logs:${Stack.of(this).region}:${this.account}:*`,
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
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:logs:${this.region}:${this.account}:*`,
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
      flowLogName: getEnvSpecificName('vpc-flow-logs'),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Add common tags to all resources in the stack
    Tags.of(this).add('Project', props.context.project);
    Tags.of(this).add('Environment', props.context.environment);
  }

  private getDnsRecord(subdomain: string, environment: DeploymentContext['environment']) {
    return `${subdomain}.${environment === 'dev' ? 'dev.' : ''}${NetworkStack.domain}`;
  }
}
