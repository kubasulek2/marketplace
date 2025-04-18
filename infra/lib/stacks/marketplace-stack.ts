import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface MarketplaceStackProps extends cdk.StackProps {
  // Add any custom props here
}

export class MarketplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: MarketplaceStackProps) {
    super(scope, id, props);

    // Add your resources here
  }
} 