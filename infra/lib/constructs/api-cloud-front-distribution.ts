import { Duration } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

import { NetworkStack } from '../stacks/network-stack';

export interface ApiCloudFrontDistributionProps {
  loadBalancerDomain: string;
  certificate: acm.ICertificate;
  domainNames: string[];
  logsBucket: s3.Bucket;
  authDomain: string;
  authClientId?: string;
  originSecret: string;
  apiDomain: string;
  deployEnv: string;
}

export class ApiCloudFrontDistribution extends Construct {
  constructor(scope: Construct, id: string, props: ApiCloudFrontDistributionProps) {
    super(scope, id);

    let redirectUnauthenticatedFunction: cloudfront.Function | undefined;
    // this is only useful when we have custom authService, as alb integration uses session cookies instead of auth tokens
    // if (props.authClientId) {
    //   redirectUnauthenticatedFunction = new cloudfront.Function(
    //     this,
    //     'RedirectUnauthenticatedFunction',
    //     {
    //       code: cloudfront.FunctionCode.fromInline(`
    //       function handler(event) {
    //         const request = event.request;
    //         const headers = request.headers;
    //         if (!headers.authorization) {
    //           return {
    //             status: '302',
    //             statusDescription: 'Found',
    //             headers: {
    //               location: {
    //                 value: 'https://${props.authDomain}/login?client_id=${props.authClientId}&response_type=token&scope=email+openid+profile&redirect_uri=https%3A%2F%2Fauth.dev.kuba-bright.com%2Fcallback',
    //               },
    //             },
    //           };
    //         }
    //         return request;
    //       }
    //     `),
    //     }
    //   );
    // }

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

    const distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(props.loadBalancerDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: {
            'X-Origin-Secret': props.originSecret,
          },
        }),
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_AND_SECURITY_HEADERS,
        functionAssociations: redirectUnauthenticatedFunction
          ? [
              {
                function: redirectUnauthenticatedFunction,
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              },
            ]
          : undefined,
      },
      additionalBehaviors: {
        '/products*': {
          origin: new origins.HttpOrigin(props.loadBalancerDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: {
              'X-Origin-Secret': props.originSecret,
            },
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: productsCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
        },
      },
      domainNames: props.domainNames,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // cost-effective for global distribution
      certificate: props.certificate,
      enableLogging: true,
      logBucket: props.logsBucket,
      logFilePrefix: 'cloudfront-access-logs/api-distribution',
    });

    // Create a Route 53 record for the API CloudFront distribution
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: NetworkStack.domain,
    });

    new route53.ARecord(this, 'ApiRecord', {
      comment: `API CloudFront Distribution ${props.deployEnv}`,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
      recordName: props.apiDomain,
      deleteExisting: true,
    });

    // Invalidate the CloudFront distribution when the app is updated
    const invalidation = new cr.AwsCustomResource(this, 'CloudFrontInvalidation', {
      onCreate: {
        service: 'CloudFront',
        action: 'createInvalidation',
        parameters: {
          DistributionId: distribution.distributionId,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Quantity: 1,
              Items: ['/*'],
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    invalidation.node.addDependency(distribution);
  }
}
