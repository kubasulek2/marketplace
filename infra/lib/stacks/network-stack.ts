import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { DeploymentContext } from '../shared/types';

export interface NetworkStackProps extends StackProps {
  context: DeploymentContext;
}

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    // Create VPC with 2 public and 2 private subnets
    this.vpc = new ec2.Vpc(this, 'MarketplaceVPC', {
      maxAzs: 2, // Use 2 Availability Zones
      vpcName: `${props.context.project}-${props.context.environment}-vpc`,
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
      natGateways: 1,
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
  }
}
