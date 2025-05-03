import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Duration } from 'aws-cdk-lib';

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

    const productsCachePolicy = new cloudfront.CachePolicy(this, 'ProductsCachePolicy', {
      cachePolicyName: 'ProductsCachePolicy',
      comment: 'Cache /products for 120s based on query params',
      defaultTtl: Duration.seconds(120),
      minTtl: Duration.seconds(20),
      maxTtl: Duration.seconds(3600),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      defaultBehavior: {
        origin: new origins.RestApiOrigin(props.apiGateway, {
          originPath: `/${props.apiGateway.deploymentStage.stageName}`,
          customHeaders: {
            'X-Origin-Secret': props.originSecret,
          },
        }),
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/products*': {
          origin: new origins.RestApiOrigin(props.apiGateway, {
            originPath: `/${props.apiGateway.deploymentStage.stageName}`,
            customHeaders: {
              'X-Origin-Secret': props.originSecret,
            },
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: productsCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
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
