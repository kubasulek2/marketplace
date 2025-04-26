import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface ApiCloudFrontDistributionProps {
  apiGateway: apigateway.RestApi;
  certificate: acm.ICertificate;
  domainNames: string[];
  originSecret: string;
  logsBucket: s3.Bucket;
}

export class ApiCloudFrontDistribution extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ApiCloudFrontDistributionProps) {
    super(scope, id);

    const apiGatewayDomain = `${props.apiGateway.restApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`;

    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiGatewayDomain, {
          originPath: `/${props.apiGateway.deploymentStage.stageName}`,
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: {
            'X-Origin-Secret': props.originSecret,
          },
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      domainNames: props.domainNames,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // cost-effective for global distribution
      certificate: props.certificate,
      enableLogging: true,
      logBucket: props.logsBucket,
      logFilePrefix: 'cloudfront-access-logs/api-distribution',
    });
  }
}
