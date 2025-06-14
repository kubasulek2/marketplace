import {
  Stack,
  StackProps,
  Tags,
  Duration,
  RemovalPolicy,
  aws_route53 as route53,
  CfnOutput,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { AppConfig, StackEnvConfig } from '../shared/config';
import { vpcEndpointId, vpcEndpointSg } from '../shared/exports';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

type CertMapping = {
  [key in AppConfig['deployEnv']]: {
    api: string;
    auth: string;
    regional: string;
  };
};

export type NetworkStackProps = StackProps & {
  config: AppConfig;
  env: StackEnvConfig;
};

export class NetworkStack extends Stack {
  public static readonly domain = 'kuba-bright.com';
  private readonly certMapping: CertMapping = {
    dev: {
      api: 'arn:aws:acm:us-east-1:536697237982:certificate/312f7793-1480-4dda-8091-4cb10e26e761',
      auth: 'arn:aws:acm:us-east-1:536697237982:certificate/7e068d81-2374-4ef3-a67e-82fd62ef1541',
      regional:
        'arn:aws:acm:eu-central-1:536697237982:certificate/8a726752-1267-4d0e-b439-31d51dd568cf',
    },
    prod: {
      api: 'arn:aws:acm:us-east-1:536697237982:certificate/aae4aa96-0391-415e-8633-0ac46705ef93',
      auth: 'arn:aws:acm:us-east-1:536697237982:certificate/7570dd87-e9e9-4691-97e2-a6d7367b93ee',
      regional:
        'arn:aws:acm:eu-central-1:536697237982:certificate/8a726752-1267-4d0e-b439-31d51dd568cf',
    },
  };

  public readonly vpc: ec2.Vpc;
  public readonly apiDomain: string;
  public readonly authDomain: string;
  public readonly apiCertificate: acm.ICertificate;
  public readonly authCertificate: acm.ICertificate;
  public readonly regionalCertificate: acm.ICertificate;
  public readonly kmsKey: kms.IAlias;
  public readonly logsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.kmsKey = kms.Alias.fromAliasName(this, 'KMSKey', 'alias/marketplace-key');

    this.apiDomain = this.getDomain('api', props.config.deployEnv);
    this.authDomain = this.getDomain('auth', props.config.deployEnv);

    this.vpc = this.createVpc(props.config);

    this.createVpcApiGatewayEndpoint(props.config);

    const { apiCertificate, regionalCertificate, authCertificate } = this.createCertificates(
      props.config
    );

    this.apiCertificate = apiCertificate;
    this.regionalCertificate = regionalCertificate;
    this.authCertificate = authCertificate;

    const { logsBucket } = this.createVpcLogs();

    this.logsBucket = logsBucket;

    this.addDevSubdomain(props.config);

    // Add common tags to all resources in the stack
    Tags.of(this).add('Project', props.config.project);
    Tags.of(this).add('Environment', props.config.deployEnv);
  }

  private getDomain(subdomain: string, environment: AppConfig['deployEnv']) {
    return `${subdomain}.${environment === 'dev' ? 'dev.' : ''}${NetworkStack.domain}`;
  }

  private createCertificates(config: AppConfig) {
    // Import existing API certificate
    const apiCertificate = acm.Certificate.fromCertificateArn(
      this,
      getEnvSpecificName('api-certificate'),
      this.certMapping[config.deployEnv].api
    );

    const regionalCertificate = acm.Certificate.fromCertificateArn(
      this,
      getEnvSpecificName('regional-certificate'),
      this.certMapping[config.deployEnv].regional
    );

    const authCertificate = acm.Certificate.fromCertificateArn(
      this,
      getEnvSpecificName('auth-certificate'),
      this.certMapping[config.deployEnv].auth
    );

    return { apiCertificate, regionalCertificate, authCertificate };
  }

  private createVpc(config: AppConfig) {
    const vpcName = getEnvSpecificName('vpc');

    const additionalSubnets = config.usePrivateSubnets
      ? [
          {
            name: 'Private1',
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24,
          },
        ]
      : [];

    // Create VPC with 2 public and 2 private subnets
    const vpc = new ec2.Vpc(this, vpcName, {
      maxAzs: 2, // Use 2 Availability Zones
      vpcName,
      ipAddresses: ec2.IpAddresses.cidr('10.231.0.0/16'),

      // Define subnet configuration
      subnetConfiguration: [
        {
          name: 'Public1',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        ...additionalSubnets,
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

      // Create a NAT Gateway for private subnets (2 for high availability)
      natGateways: config.usePrivateSubnets ? 1 : undefined,
    });

    // Add tags to all subnets
    vpc.publicSubnets.forEach((subnet, index) => {
      Tags.of(subnet).add(
        'Name',
        `${config.project}-${config.deployEnv}-public-subnet-${index + 1}`
      );
    });

    vpc.privateSubnets.forEach((subnet, index) => {
      Tags.of(subnet).add(
        'Name',
        `${config.project}-${config.deployEnv}-private-subnet-${index + 1}`
      );
    });

    return vpc;
  }

  private createVpcLogs() {
    // Logging bucket
    const logsBucket = new s3.Bucket(this, getEnvSpecificName('logs-bucket'), {
      bucketName: getEnvSpecificName(`logs-${this.account}`),
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
      // encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      bucketKeyEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // this is not executed because we import the key - left here for reference (done manually)
    this.kmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:EncryptionContext:aws:s3:arn': logsBucket.arnForObjects('*'),
          },
        },
      })
    );

    // this is not executed because we import the key - left here for reference (done manually)
    this.kmsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEC2AndEBSUsage',
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        principals: [new iam.ServicePrincipal('ec2.amazonaws.com')],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ec2.${this.region}.amazonaws.com`,
          },
        },
      })
    );

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

    new ec2.FlowLog(this, 'VPCFlowLogs', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toS3(logsBucket, 'vpc-flow-logs', {
        fileFormat: ec2.FlowLogFileFormat.PARQUET,
      }),
      flowLogName: getEnvSpecificName('vpc-flow-logs'),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
    return { logsBucket };
  }

  private createVpcApiGatewayEndpoint(config: AppConfig) {
    if (config.usePrivateSubnets) {
      const sg = new ec2.SecurityGroup(this, 'ApiEndpointSG', {
        securityGroupName: getEnvSpecificName('api-endpoint-sg'),
        vpc: this.vpc,
        description: 'Allow ECS service to call API Gateway via interface endpoint',
        allowAllOutbound: true,
      });

      const endpoint = this.vpc.addInterfaceEndpoint('InterfaceApiEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
        privateDnsEnabled: true,
        subnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [sg],
      });

      new CfnOutput(this, 'VpcEndpointSGIdOutput', {
        value: sg.securityGroupId,
        exportName: vpcEndpointSg,
      });

      new CfnOutput(this, 'VpcEndpointId', {
        value: endpoint.vpcEndpointId,
        exportName: vpcEndpointId,
      });

      return endpoint;
    }
    return undefined;
  }

  private addDevSubdomain(config: AppConfig) {
    if (config.deployEnv === 'dev') {
      const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
        domainName: NetworkStack.domain,
      });

      new route53.ARecord(this, 'DevSubdomainARecord', {
        zone: hostedZone,
        recordName: 'dev.kuba-bright.com',
        target: route53.RecordTarget.fromIpAddresses('0.0.0.0'),
      });
    }
  }
}
