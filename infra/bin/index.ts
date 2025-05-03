import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { getEnvironment } from '../lib/shared/environment';
import { getEnvSpecificName } from '../lib/shared/getEnvSpecificName';
import { AppStack } from '../lib/stacks/app-stack';
import { AuthStack } from '../lib/stacks/auth-stack';

const app = new cdk.App();
const environment = getEnvironment();
const networkStackName = getEnvSpecificName('NetworkStack');
const appStackName = getEnvSpecificName('AppStack');
const authStackName = getEnvSpecificName('AuthStack');

const networkStack = new NetworkStack(app, networkStackName, environment);

const appStack = new AppStack(app, appStackName, {
  ...environment,
  vpc: networkStack.vpc,
  apiCertificate: networkStack.apiCertificate,
  regionalCertificate: networkStack.regionalCertificate,
  apiDnsRecord: networkStack.apiDnsRecord,
  authDnsRecord: networkStack.authDnsRecord,
  logsBucket: networkStack.logsBucket,
  kmsKey: networkStack.kmsKey,
});

const authStack = new AuthStack(app, authStackName, {
  ...environment,
  restApi: appStack.restApi,
  authDnsRecord: networkStack.authDnsRecord,
});
