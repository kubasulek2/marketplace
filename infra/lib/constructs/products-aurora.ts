import { aws_rds, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  ClusterScalabilityType,
  DatabaseInsightsMode,
  DBClusterStorageType,
  InstanceUpdateBehaviour,
  PerformanceInsightRetention,
  ParameterGroup,
  ProxyTarget,
  DatabaseProxy,
} from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

import { AppConfig } from '../shared/config';
import { scalingConfig } from '../shared/scaling-config';

const EC2_INSTANCE_SIZE_MAP: Record<string, ec2.InstanceSize> = {
  MICRO: ec2.InstanceSize.MICRO,
  SMALL: ec2.InstanceSize.SMALL,
  MEDIUM: ec2.InstanceSize.MEDIUM,
  LARGE: ec2.InstanceSize.LARGE,
  XLARGE: ec2.InstanceSize.XLARGE,
};
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

interface ProductsAuroraProps {
  appConfig: AppConfig;
  vpc: ec2.IVpc;
}

export class ProductsAurora extends Construct {
  public readonly cluster: aws_rds.DatabaseCluster;
  public readonly dbSecurityGroup: ec2.ISecurityGroup;
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, props: ProductsAuroraProps) {
    super(scope, id);
    const { appConfig, vpc } = props;
    const isProd = appConfig.deployEnv === 'prod';
    const engineVersion = aws_rds.AuroraPostgresEngineVersion.VER_16_8;

    const clusterParamGroup = new ParameterGroup(this, 'ParamGroup', {
      engine: aws_rds.DatabaseClusterEngine.auroraPostgres({
        version: engineVersion,
      }),
      parameters: {
        'rds.force_ssl': '1',
      },
    });

    const subnetGroup = new aws_rds.SubnetGroup(this, 'ProductsSubnetGroup', {
      description: 'Products DB subnet group',
      vpc,
      vpcSubnets: {
        subnetType: appConfig.usePrivateSubnets
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PUBLIC,
      },
      subnetGroupName: 'products-subnet-group',
    });

    const instanceType = ec2.InstanceType.of(
      ec2.InstanceClass.T3,
      EC2_INSTANCE_SIZE_MAP[scalingConfig.auroraInstanceSize] ?? ec2.InstanceSize.MEDIUM
    );

    const monitoringRole = new Role(this, 'MonitoringRole', {
      assumedBy: new ServicePrincipal('monitoring.rds.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole'),
      ],
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc,
      description: 'Security group for Aurora PostgreSQL',
      allowAllOutbound: true,
    });

    this.cluster = new aws_rds.DatabaseCluster(this, 'ProductsAurora', {
      instanceIdentifierBase: getEnvSpecificName('products-aurora-instance'),
      clusterIdentifier: getEnvSpecificName('products-aurora'),
      defaultDatabaseName: 'products',
      engine: aws_rds.DatabaseClusterEngine.auroraPostgres({
        version: engineVersion,
      }),
      credentials: aws_rds.Credentials.fromGeneratedSecret('app'),
      autoMinorVersionUpgrade: true,
      backup: {
        retention: appConfig.performanceMode
          ? Duration.days(scalingConfig.auroraBackupRetentionPerf)
          : Duration.days(scalingConfig.auroraBackupRetentionDev),
      },
      writer: aws_rds.ClusterInstance.provisioned('writer', {
        instanceType,
        autoMinorVersionUpgrade: true,
        publiclyAccessible: false,
        enablePerformanceInsights: true,
      }),
      readers: appConfig.performanceMode
        ? [
            aws_rds.ClusterInstance.provisioned('reader', {
              instanceType,
              autoMinorVersionUpgrade: true,
              publiclyAccessible: false,
              enablePerformanceInsights: true,
            }),
          ]
        : [],
      deletionProtection: isProd,
      vpc,
      vpcSubnets: {
        subnetType: appConfig.usePrivateSubnets
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PUBLIC,
      },
      // iamAuthentication: true,
      clusterScalabilityType: ClusterScalabilityType.STANDARD,
      copyTagsToSnapshot: true,
      databaseInsightsMode: DatabaseInsightsMode.STANDARD,
      enablePerformanceInsights: true,
      performanceInsightRetention: PerformanceInsightRetention.DEFAULT,
      cloudwatchLogsExports: ['postgresql'],
      instanceUpdateBehaviour: InstanceUpdateBehaviour.ROLLING,
      monitoringInterval: Duration.seconds(60),
      monitoringRole,
      enableClusterLevelEnhancedMonitoring: true,
      parameterGroup: clusterParamGroup,
      preferredMaintenanceWindow: 'Mon:02:45-Mon:03:15',
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      storageEncrypted: true,
      // TODO: Add storage encryption key later
      // storageEncryptionKey,
      storageType: DBClusterStorageType.AURORA,
      subnetGroup,
      securityGroups: [this.dbSecurityGroup],
    });

    if (appConfig.performanceMode) {
      const scalableTarget = new autoscaling.ScalableTarget(
        this,
        'AuroraReadReplicaScalingTarget',
        {
          serviceNamespace: autoscaling.ServiceNamespace.RDS,
          maxCapacity: scalingConfig.auroraReplicaMax,
          minCapacity: scalingConfig.auroraReplicaMin,
          resourceId: `cluster:${this.cluster.clusterIdentifier}`,
          scalableDimension: 'rds:cluster:ReadReplicaCount',
        }
      );

      scalableTarget.scaleToTrackMetric('CPUUtilizationTrackingPolicy', {
        targetValue: scalingConfig.auroraReplicaCpuTarget,
        predefinedMetric: autoscaling.PredefinedMetric.RDS_READER_AVERAGE_CPU_UTILIZATION,
        scaleInCooldown: Duration.seconds(300),
        scaleOutCooldown: Duration.seconds(300),
      });
    }
    // Create a proxy for the cluster
    const proxy = new DatabaseProxy(this, 'ProductsDbProxy', {
      proxyTarget: ProxyTarget.fromCluster(this.cluster),
      dbProxyName: getEnvSpecificName('products-aurora-proxy'),
      secrets: [this.cluster.secret!],
      vpc: props.vpc,
      requireTLS: true,
      // iamAuth: true,
      securityGroups: [this.dbSecurityGroup],
      vpcSubnets: {
        subnetType: appConfig.usePrivateSubnets
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PUBLIC,
      },
      idleClientTimeout: Duration.minutes(30),
      maxConnectionsPercent: scalingConfig.rdsProxyMaxConnectionsPct,
      debugLogging: false,
    });
    this.endpoint = proxy.endpoint;

    // allow proxy to connect to DB
    this.dbSecurityGroup.addIngressRule(
      this.dbSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow RDS Proxy to connect to DB'
    );
  }
}
