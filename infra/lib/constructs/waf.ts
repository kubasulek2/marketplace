import * as cdk from 'aws-cdk-lib';
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafregional';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface WafProps {
  distribution: Distribution;
}

export class Waf extends Construct {
  constructor(scope: Construct, id: string, props: WafProps) {
    super(scope, id);

    const { distribution } = props;

    const rules: CfnWebACL.RuleProperty[] = [
      {
        name: 'AWS-AWSManagedRulesAmazonIpReputationList',
        priority: 0,
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesAmazonIpReputationList',
          },
        },
        overrideAction: {
          none: {},
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'AWS-AWSManagedRulesAmazonIpReputationList',
        },
      },
      {
        name: 'AWS-AWSManagedRulesLinuxRuleSet',
        priority: 1,
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesLinuxRuleSet',
            version: 'Version_2.0',
          },
        },
        overrideAction: {
          none: {},
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'AWS-AWSManagedRulesLinuxRuleSet',
        },
      },
      {
        name: 'AWS-AWSManagedRulesCommonRuleSet',
        priority: 2,
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
          },
        },
        overrideAction: {
          none: {},
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'AWS-AWSManagedRulesCommonRuleSet',
        },
      },
      {
        name: 'DDoS_Rule',
        priority: 3,
        statement: {
          rateBasedStatement: {
            limit: 100,
            aggregateKeyType: 'IP',
          },
        },
        action: {
          block: {},
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: 'DDoS_Rule',
        },
      },
    ];

    const webAcl = new CfnWebACL(this, 'WebAcl', {
      name: getEnvSpecificName('WAF'),
      scope: 'CLOUDFRONT',
      defaultAction: {
        allow: {},
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'cloudfront-waf-metrics',
        sampledRequestsEnabled: true,
      },
      rules,
    });

    new CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: `arn:aws:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${distribution.distributionId}`,
      webAclId: webAcl.attrId,
    });
  }
}
