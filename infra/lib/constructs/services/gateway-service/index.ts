import { RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { UserPool, UserPoolClient, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { AppConfig } from '../../../shared/config';
import { getEnvSpecificName } from '../../../shared/getEnvSpecificName';
import { NetworkStack } from '../../../stacks/network-stack';

import { GatewayAlb } from './gateway-alb';

interface GatewayEcsServiceProps {
  vpc: ec2.Vpc;
  certificate: acm.ICertificate;
  config: AppConfig;
  kmsKey: kms.IAlias;
  originSecret: string;
  userPool?: UserPool;
  userPoolClient?: UserPoolClient;
  userPoolDomain?: UserPoolDomain;
}

export class GatewayEcsService extends Construct {
  public static readonly loadBalancerDnsName = `alb1.${NetworkStack.domain}`;

  constructor(scope: Construct, id: string, props: GatewayEcsServiceProps) {
    super(scope, id);
    const clusterName = getEnvSpecificName('gateway-ecs-cluster');

    // Create a security group for the ECS instances
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: getEnvSpecificName('GatewayEcsSecurityGroup'),
      description: 'Security group for ECS instances',
      allowAllOutbound: true,
    });

    // Create the IAM role for EC2 instances
    const ecsInstanceRole = new iam.Role(this, 'ECSInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    ecsInstanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    ecsInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:CreateCluster',
          'ecs:DeregisterContainerInstance',
          'ecs:DiscoverPollEndpoint',
          'ecs:Poll',
          'ecs:RegisterContainerInstance',
          'ecs:StartTelemetrySession',
          'ecs:UpdateContainerInstancesState',
          'ecs:Submit*',
        ],
        resources: ['*'],
      })
    );

    ecsInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: [props.kmsKey.keyArn],
      })
    );

    const userData = ec2.UserData.forLinux({
      shebang: '#!/bin/bash',
    });

    userData.addCommands(`echo "ECS_CLUSTER=${clusterName}" >> /etc/ecs/ecs.config`);

    // Create the launch template
    const launchTemplate = new ec2.LaunchTemplate(this, 'ECSLaunchTemplate', {
      launchTemplateName: getEnvSpecificName('GatewayEcsLaunchTemplate'),
      versionDescription: 'v1',
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id'
      ),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        props.config.performanceMode ? ec2.InstanceSize.MEDIUM : ec2.InstanceSize.MICRO
      ),
      detailedMonitoring: true,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            deleteOnTermination: true,
            encrypted: true,
            // kmsKey: props.kmsKey,
          }),
        },
      ],
      userData: userData,
      securityGroup: ecsSecurityGroup,
      instanceProfile: new iam.InstanceProfile(this, 'ECSInstanceProfile', {
        instanceProfileName: getEnvSpecificName('GatewayEcsInstanceProfile'),
        role: ecsInstanceRole,
      }),
    });

    const taskRole = new iam.Role(this, 'GatewayTaskRole', {
      roleName: getEnvSpecificName('GatewayTaskRole'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [],
    });

    // TODO: add later
    // taskRole.addToPolicy(
    //   new iam.PolicyStatement({
    //     actions: ['secretsmanager:GetSecretValue'],
    //     resources: ['*'],
    //   })
    // );

    const executionRole = new iam.Role(this, 'GatewayTaskExecutionRole', {
      roleName: getEnvSpecificName('GatewayTaskExecutionRole'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskDefinition = new ecs.Ec2TaskDefinition(
      this,
      getEnvSpecificName('GatewayTaskDefinition'),
      {
        family: getEnvSpecificName('gateway-task-definition'),
        taskRole, // this is application code role
        executionRole, // this is ECS related role eg secretsmanager, cloudwatch logs, etc
      }
    );

    const ecsLogGroup = new logs.LogGroup(this, 'GatewayLogGroup', {
      logGroupName: getEnvSpecificName('GatewayLogGroup'),
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer('GatewayContainer', {
      image: ecs.ContainerImage.fromRegistry('hashicorp/http-echo'),
      essential: true,
      portMappings: [
        {
          containerPort: 80,
          hostPort: 0, // ECS chooses port
          protocol: ecs.Protocol.TCP,
        },
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'gateway',
        logGroup: ecsLogGroup,
      }),
      environment: {
        HOST: '0.0.0.0',
      },
      command: ['-listen=:80', '-text=Hello from Gateway'],
      cpu: 256, // 256 CPU units = 1/4 vCPU
      memoryReservationMiB: 256, // soft limit
      memoryLimitMiB: 512, // hard limit
      // Do not use it with hashicorp/http-echo as it doesn't include shell not curl
      // healthCheck: {
      //   command: ['CMD-SHELL', 'curl -f http://localhost:80/ || exit 1'],
      //   interval: Duration.seconds(30),
      //   timeout: Duration.seconds(5),
      //   retries: 3,
      //   startPeriod: Duration.seconds(60),
      // },
    });

    const cluster = new ecs.Cluster(this, clusterName, {
      clusterName,
      vpc: props.vpc,
    });

    // Create Auto Scaling Group (ASG) for ECS instances
    const asg = new autoscaling.AutoScalingGroup(this, 'ECSAutoScalingGroup', {
      vpc: props.vpc,
      minCapacity: props.config.performanceMode ? 2 : 1,
      maxCapacity: props.config.performanceMode ? 8 : 2,
      vpcSubnets: props.config.usePrivateSubnets
        ? {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          }
        : undefined,
      launchTemplate: launchTemplate,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: Duration.seconds(60),
      }),

      allowAllOutbound: true,
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
      autoScalingGroupName: getEnvSpecificName('GatewayAutoScalingGroup'),
      azCapacityDistributionStrategy: autoscaling.CapacityDistributionStrategy.BALANCED_BEST_EFFORT,
      cooldown: Duration.minutes(3),
      defaultInstanceWarmup: Duration.minutes(3),
    });

    // Create the ECS Capacity Provider with the Auto Scaling Group
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'GatewayCapacityProvider', {
      capacityProviderName: getEnvSpecificName('GatewayCapacityProvider'),
      autoScalingGroup: asg,
      enableManagedScaling: true,
      enableManagedDraining: true,
      instanceWarmupPeriod: 180, // match ASG settings (3 minutes)
      enableManagedTerminationProtection: false, // Allow scale-in even when tasks are running
    });

    // Attach the capacity provider to the ECS cluster
    cluster.addAsgCapacityProvider(capacityProvider);

    const service = new ecs.Ec2Service(this, getEnvSpecificName('GatewayService'), {
      cluster,
      taskDefinition,
      capacityProviderStrategies: [
        {
          capacityProvider: capacityProvider.capacityProviderName,
          base: 1,
          weight: 1,
        },
      ],
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      enableExecuteCommand: true,
      healthCheckGracePeriod: Duration.seconds(60),
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      serviceName: getEnvSpecificName('GatewayService'),
    });

    // ECS Service Auto Scaling (Task level auto scaling)
    const scalableTarget = service.autoScaleTaskCount({
      minCapacity: props.config.performanceMode ? 2 : 1,
      maxCapacity: props.config.performanceMode ? 8 : 4,
    });

    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      policyName: 'CpuScalingPolicy',
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });

    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 60,
      policyName: 'MemoryScalingPolicy',
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });

    const gatewayAlb = new GatewayAlb(this, 'GatewayAlb', {
      vpc: props.vpc,
      certificate: props.certificate,
      originSecret: props.originSecret,
      service,
      scalableTarget,
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      userPoolDomain: props.userPoolDomain,
    });

    // Allow Load Balancer to communicate with ECS instances (ALB → ECS)
    ecsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(gatewayAlb.loadBalancerSecurityGroup.securityGroupId),
      ec2.Port.allTraffic(),
      'Allow all traffic from Load Balancer'
    );

    // ECS Task CPU and Memory alarms
    new cloudwatch.Alarm(this, 'EcsCpuAlarm', {
      metric: service.metricCpuUtilization({
        period: Duration.minutes(1),
      }),
      alarmName: getEnvSpecificName('GatewayCpuAlarm'),
      threshold: 80, // 80% CPU usage threshold
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
  }
}
