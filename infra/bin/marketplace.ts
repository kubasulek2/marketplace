import * as cdk from 'aws-cdk-lib';
import { MarketplaceStack } from '../lib/stacks/marketplace-stack';

const app = new cdk.App();

// Create the main stack
new MarketplaceStack(app, 'MarketplaceStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Main stack for the Marketplace infrastructure',
}); 