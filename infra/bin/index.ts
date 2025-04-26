import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { getEnvironment } from '../lib/shared/environment';
import { getEnvSpecificName } from '../lib/shared/getEnvSpecificName';
import { AppStack } from '../lib/stacks/app-stack';

const app = new cdk.App();
const environment = getEnvironment();
const networkStackName = getEnvSpecificName('NetworkStack');
const appStackName = getEnvSpecificName('AppStack');

const networkStack = new NetworkStack(app, networkStackName, environment);

const appStack = new AppStack(app, appStackName, {
  ...environment,
  vpc: networkStack.vpc,
  apiCertificate: networkStack.apiCertificate,
  apiDnsRecord: networkStack.apiDnsRecord,
  authCertificate: networkStack.authCertificate,
  authDnsRecord: networkStack.authDnsRecord,
  logsBucket: networkStack.logsBucket,
});
