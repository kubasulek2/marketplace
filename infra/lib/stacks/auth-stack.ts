import { Duration, Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import {
  AccountRecovery,
  FeaturePlan,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
  UserPoolEmail,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import { AppConfig, StackEnvConfig } from '../shared/config';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

import { NetworkStack } from './network-stack';

export interface AuthStackProps extends StackProps {
  config: AppConfig;
  env: StackEnvConfig;
  authDomain: string;
  apiDomain: string;
  authCertificate: acm.ICertificate;
}

export class AuthStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly userPoolDomain: UserPoolDomain;
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: NetworkStack.domain,
    });

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: getEnvSpecificName('UserPool'),
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      userVerification: {
        emailBody: 'Your verification code is {####}',
        emailSubject: 'Marketplace - Your verification code',
        emailStyle: VerificationEmailStyle.CODE,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      standardAttributes: {
        email: { required: true, mutable: true },
        preferredUsername: { required: true, mutable: true },
      },
      email: UserPoolEmail.withCognito(),
      featurePlan: FeaturePlan.LITE,
      // lambdaTriggers: {
      //   postConfirmation: ,
      // },
    });

    this.userPool.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: getEnvSpecificName('UserPoolClient'),
      oAuth: {
        callbackUrls: [
          `https://${props.apiDomain}/oauth2/idpresponse`,
          `https://${props.authDomain}/callback`,
        ],
        logoutUrls: [
          `https://${props.authDomain}/logout`,
          `https://dev.${props.authDomain}/logout`,
        ],
        defaultRedirectUri: `https://${props.apiDomain}/oauth2/idpresponse`,
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE],
        flows: {
          authorizationCodeGrant: true,
          // remove this once we have a proper redirect uri
          implicitCodeGrant: true,
        },
      },
      accessTokenValidity: Duration.hours(6),
      idTokenValidity: Duration.hours(6),
      refreshTokenValidity: Duration.days(60),
      authSessionValidity: Duration.minutes(50),
      enableTokenRevocation: true,
      generateSecret: true, // required for load balancer auth and for backend apps
      preventUserExistenceErrors: true,
      // only matters when not using hosted ui
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    this.userPoolClient = userPoolClient;

    this.userPoolDomain = new UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      customDomain: {
        domainName: props.authDomain,
        certificate: props.authCertificate,
      },
    });

    this.userPoolDomain.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const domainTarget = new targets.UserPoolDomainTarget(this.userPoolDomain);

    const aliasRecord = new route53.ARecord(this, 'AuthDomainAliasRecord', {
      zone: hostedZone,
      recordName: props.authDomain,
      target: route53.RecordTarget.fromAlias(domainTarget),
    });

    aliasRecord.node.addDependency(this.userPoolDomain);
  }
}
