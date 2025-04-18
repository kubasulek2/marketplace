import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/networking-stack';
import { getEnvironment } from '../lib/shared/environment';

const app = new cdk.App();
const environment = getEnvironment();

const networkStack = new NetworkStack(app, 'MarketplaceStack', environment);
