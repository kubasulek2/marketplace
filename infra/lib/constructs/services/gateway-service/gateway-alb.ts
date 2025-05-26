import { Duration } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import { getEnvSpecificName } from '../../../shared/getEnvSpecificName';
import { NetworkStack } from '../../../stacks/network-stack';

interface GatewayAlbProps {
  vpc: ec2.Vpc;
  certificate: acm.ICertificate;
  originSecret: string;
  service: ecs.Ec2Service;
  scalableTarget: ecs.ScalableTaskCount;
  ecsSecurityGroup: ec2.SecurityGroup;
  userPool?: cognito.UserPool;
  userPoolClient?: cognito.UserPoolClient;
  userPoolDomain?: cognito.UserPoolDomain;
}
export class GatewayAlb extends Construct {
  public readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  constructor(scope: Construct, id: string, props: GatewayAlbProps) {
    super(scope, id);

    const useAuth = props.userPool && props.userPoolClient && props.userPoolDomain;

    this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: getEnvSpecificName('GatewayLoadBalancerSecurityGroup'),
      description: 'Security group for Load Balancer',
      allowAllOutbound: true,
    });

    // Allow HTTP and HTTPS traffic from VPC CIDR
    this.loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from VPC'
    );
    this.loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from VPC'
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, getEnvSpecificName('GatewayALB'), {
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: this.loadBalancerSecurityGroup,
      loadBalancerName: getEnvSpecificName('GatewayALB'),
      internetFacing: true,
    });

    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: NetworkStack.domain,
    });

    new route53.ARecord(this, getEnvSpecificName('AlbPrivateDnsRecord'), {
      zone: hostedZone,
      recordName: 'alb1',
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
    });

    const listener = alb.addListener(getEnvSpecificName('GatewayEcsClusterALBListener'), {
      port: 443,
      certificates: [props.certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(401, {
        contentType: 'application/json',
        messageBody: JSON.stringify({ message: 'Unauthorized' }),
      }),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targets: [props.service],
      port: 80,
      vpc: props.vpc,
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

    // 1️⃣ Public route: GET /products (no Cognito auth, but requires origin secret)
    listener.addAction('PublicProductsRoute', {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader('X-Origin-Secret', [props.originSecret]),
        elbv2.ListenerCondition.pathPatterns(['/products']),
        elbv2.ListenerCondition.httpRequestMethods(['GET']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // 2️⃣ Authenticated route: all other paths, with Cognito auth + origin secret
    listener.addAction('AuthenticatedRoutes', {
      priority: 2,
      conditions: [
        elbv2.ListenerCondition.httpHeader('X-Origin-Secret', [props.originSecret]),
        elbv2.ListenerCondition.pathPatterns(['/*']),
      ],
      action: useAuth
        ? new elbv2_actions.AuthenticateCognitoAction({
            userPool: props.userPool!,
            userPoolClient: props.userPoolClient!,
            userPoolDomain: props.userPoolDomain!,
            sessionTimeout: Duration.hours(6),
            next: elbv2.ListenerAction.forward([targetGroup]),
          })
        : elbv2.ListenerAction.forward([targetGroup]),
    });

    new cloudwatch.Alarm(this, 'AlbUnhealthyHostsAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          TargetGroup: targetGroup.targetGroupFullName,
          LoadBalancer: alb.loadBalancerFullName,
        },
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      alarmName: getEnvSpecificName('GatewayAlbUnhealthyHostsAlarm'),
      threshold: 0, // Alarm if any host is unhealthy
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Scale based on Request Count
    props.scalableTarget.scaleOnMetric('ScaleOnRequestCount', {
      metric: alb.metrics.requestCount({
        period: Duration.minutes(1),
      }),
      scalingSteps: [
        { lower: 100, change: 1 }, // Increase by 1 task if request count > 100
        { lower: 200, change: 2 }, // Increase by 2 tasks if request count > 200
      ],
      evaluationPeriods: 2,
    });

    // Optionally, scale based on Target Response Time
    props.scalableTarget.scaleOnMetric('ScaleOnResponseTime', {
      metric: alb.metrics.targetResponseTime({
        period: Duration.minutes(1),
      }),
      scalingSteps: [
        { lower: 2, change: 1 },
        { lower: 3, change: 2 },
      ],
      evaluationPeriods: 2,
    });

    // Allow Load Balancer to communicate with ECS instances (ALB → ECS)
    props.ecsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.loadBalancerSecurityGroup.securityGroupId),
      ec2.Port.allTraffic(),
      'Allow all traffic from Load Balancer'
    );
  }
}
