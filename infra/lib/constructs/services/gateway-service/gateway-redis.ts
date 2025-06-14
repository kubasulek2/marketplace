import { aws_ec2 as ec2, aws_elasticache as elasticache, aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { AppConfig } from '../../../shared/config';
import { getEnvSpecificName } from '../../../shared/getEnvSpecificName';

export interface RedisClusterConstructProps {
  vpc: ec2.IVpc;
  appConfig: AppConfig;
}

export class RedisGatewayCluster extends Construct {
  public readonly redisSecurityGroup: ec2.ISecurityGroup;
  public readonly redisRole: iam.Role;
  public readonly redisCluster: elasticache.CfnCacheCluster | elasticache.CfnReplicationGroup;
  public readonly redisPassword: string;

  constructor(scope: Construct, id: string, props: RedisClusterConstructProps) {
    super(scope, id);

    const { vpc } = props;

    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'Security group for Redis cluster',
      allowAllOutbound: true,
    });

    const subnets = props.appConfig.usePrivateSubnets ? vpc.privateSubnets : vpc.publicSubnets;
    new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis',
      subnetIds: subnets.map((subnet) => subnet.subnetId),
      cacheSubnetGroupName: getEnvSpecificName('redis-subnet-group'),
    });

    this.redisPassword = 'my-secret-token';

    if (props.appConfig.performanceMode) {
      this.redisCluster = new elasticache.CfnReplicationGroup(this, 'RedisReplicationGroup', {
        replicationGroupDescription: 'Redis cluster mode disabled',
        cacheNodeType: 'cache.t3.micro',
        engine: 'redis',
        engineVersion: '7.0',
        authToken: this.redisPassword,
        ipDiscovery: 'ipv4',
        // kmsKeyId // TODO: add kms key,
        multiAzEnabled: props.appConfig.performanceMode ? true : false,
        networkType: 'ipv4',
        numNodeGroups: 1,
        replicasPerNodeGroup: props.appConfig.performanceMode ? 0 : 1,
        replicationGroupId: getEnvSpecificName('redis-cluster'),
        snapshotName: getEnvSpecificName('redis-snapshot'),
        snapshotRetentionLimit: 1,
        snapshottingClusterId: getEnvSpecificName('redis-cluster'),
        snapshotWindow: '00:00-06:00',
        clusterMode: 'disabled',
        atRestEncryptionEnabled: true,
        autoMinorVersionUpgrade: true,

        automaticFailoverEnabled: true,
        cacheSubnetGroupName: getEnvSpecificName('redis-subnet-group'),
        securityGroupIds: [this.redisSecurityGroup.securityGroupId],
        transitEncryptionMode: 'required',
        transitEncryptionEnabled: true,
      });
    }
  }
}
