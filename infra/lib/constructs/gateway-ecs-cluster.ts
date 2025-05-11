import { RemovalPolicy, Tags, Duration } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import { getEnvSpecificName } from '../shared/getEnvSpecificName';
import { DeploymentContext } from '../shared/types';
import { NetworkStack } from '../stacks/network-stack';

interface GatewayEcsClusterProps {
  vpc: ec2.Vpc;
  certificate: acm.ICertificate;
  context: DeploymentContext;
  kmsKey: kms.IAlias;
}

export class GatewayEcsCluster extends Construct {
  public readonly loadBalancerDnsName = `alb1.${NetworkStack.domain}`;

  constructor(scope: Construct, id: string, props: GatewayEcsClusterProps) {
    super(scope, id);
    const clusterName = getEnvSpecificName('gateway-ecs-cluster');

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: getEnvSpecificName('GatewayLoadBalancerSecurityGroup'),
      description: 'Security group for Load Balancer',
      allowAllOutbound: true,
    });

    const apiGatewayCidrs = [
      '18.153.168.0/23',
      '3.123.14.0/24',
      '3.123.15.0/25',
      '3.127.74.0/23',
      '3.66.172.0/24',
      '3.70.195.128/25',
      '3.70.195.64/26',
      '3.70.211.0/25',
      '3.71.104.0/24',
      '3.71.120.0/22',
      '3.72.168.0/24',
      '3.72.33.128/25',
    ];

    // Allow HTTP and HTTPS traffic from VPC CIDR
    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from VPC'
    );
    loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from VPC'
    );

    // Allow HTTP and HTTPS traffic from API Gateway IP range (use AWS IP range for API Gateway)
    apiGatewayCidrs.forEach((cidr) => {
      loadBalancerSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        'Allow HTTPS traffic from API Gateway'
      );
    });

    // Create a security group for the ECS instances
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: getEnvSpecificName('GatewayEcsSecurityGroup'),
      description: 'Security group for ECS instances',
      allowAllOutbound: true,
    });

    // Allow Load Balancer to communicate with ECS instances (ALB → ECS)
    ecsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(loadBalancerSecurityGroup.securityGroupId),
      ec2.Port.allTraffic(),
      'Allow all traffic from Load Balancer'
    );

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
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
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
      minCapacity: 1,
      maxCapacity: 2,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
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

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, getEnvSpecificName('GatewayALB'), {
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: loadBalancerSecurityGroup,
      loadBalancerName: getEnvSpecificName('GatewayALB'),
      internetFacing: true,
    });

    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: NetworkStack.domain,
    });

    new route53.ARecord(this, getEnvSpecificName('AlbPrivateDnsRecord'), {
      zone: hostedZone,
      recordName: 'alb1',
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer)),
    });

    const listener = loadBalancer.addListener(getEnvSpecificName('GatewayEcsClusterALBListener'), {
      port: 443,
      certificates: [props.certificate],
    });

    const targetGroup = listener.addTargets('TargetGroup', {
      targets: [service],
      port: 80,
      targetGroupName: getEnvSpecificName('gtg'),
      deregistrationDelay: Duration.seconds(30),
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/',
        port: 'traffic-port',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: Duration.seconds(10), // Increased timeout
        interval: Duration.seconds(30),
        healthyHttpCodes: '200-399', // Accept more status codes
      },
    });

    // ECS Service Auto Scaling (Task level auto scaling)
    const scalableTarget = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
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

    // Scale based on Request Count
    scalableTarget.scaleOnMetric('ScaleOnRequestCount', {
      metric: loadBalancer.metrics.requestCount({
        period: Duration.minutes(1),
      }),
      scalingSteps: [
        { lower: 100, change: 1 }, // Increase by 1 task if request count > 100
        { lower: 200, change: 2 }, // Increase by 2 tasks if request count > 200
      ],
      evaluationPeriods: 2,
    });

    // Optionally, scale based on Target Response Time
    scalableTarget.scaleOnMetric('ScaleOnResponseTime', {
      metric: loadBalancer.metrics.targetResponseTime({
        period: Duration.minutes(1),
      }),
      scalingSteps: [
        { lower: 2, change: 1 },
        { lower: 3, change: 2 },
      ],
      evaluationPeriods: 2,
    });

    // ECS Task CPU and Memory alarms
    const cpuAlarm = new cloudwatch.Alarm(this, 'EcsCpuAlarm', {
      metric: service.metricCpuUtilization({
        period: Duration.minutes(1),
      }),
      alarmName: getEnvSpecificName('GatewayCpuAlarm'),
      threshold: 80, // 80% CPU usage threshold
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    const tgUnhealthyHostsAlarm = new cloudwatch.Alarm(this, 'AlbUnhealthyHostsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          TargetGroup: targetGroup.targetGroupFullName,
          LoadBalancer: loadBalancer.loadBalancerFullName,
        },
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      alarmName: getEnvSpecificName('GatewayAlbUnhealthyHostsAlarm'),
      threshold: 0, // Alarm if any host is unhealthy
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    Tags.of(this).add('Environment', props.context.environment);
    Tags.of(this).add('Project', props.context.project);
  }
}
