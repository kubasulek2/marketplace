import * as cdk from 'aws-cdk-lib';

import { appConfig, stackEnvConfig } from '../lib/shared/config';
import { getEnvSpecificName } from '../lib/shared/getEnvSpecificName';
import { AppStack } from '../lib/stacks/app-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

const app = new cdk.App();
const networkStackName = getEnvSpecificName('NetworkStack');
const appStackName = getEnvSpecificName('AppStack');
const authStackName = getEnvSpecificName('AuthStack');

const networkStack = new NetworkStack(app, networkStackName, {
  config: appConfig,
  env: stackEnvConfig,
});

let authStack: AuthStack | undefined;

if (appConfig.useAuth) {
  authStack = new AuthStack(app, authStackName, {
    config: appConfig,
    env: stackEnvConfig,
    authDomain: networkStack.authDomain,
    authCertificate: networkStack.authCertificate,
    apiDomain: networkStack.apiDomain,
  });
}

const appStack = new AppStack(app, appStackName, {
  config: appConfig,
  env: stackEnvConfig,
  vpc: networkStack.vpc,
  apiCertificate: networkStack.apiCertificate,
  regionalCertificate: networkStack.regionalCertificate,
  apiDomain: networkStack.apiDomain,
  authDomain: networkStack.authDomain,
  logsBucket: networkStack.logsBucket,
  kmsKey: networkStack.kmsKey,
  userPool: authStack?.userPool,
  userPoolClient: authStack?.userPoolClient,
  userPoolDomain: authStack?.userPoolDomain,
});
