import dotenv from 'dotenv';
import { StackProps } from 'aws-cdk-lib';
import { DeploymentContext } from './types';

dotenv.config({ path: '.env.local' });

export const getEnvironment = (): {
  context: DeploymentContext;
  env: StackProps['env'];
} => {
  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  };

  return {
    context: {
      project: 'marketplace',
      environment: process.env.DEPLOY_ENV as 'dev' | 'staging' | 'prod',
    },
    env,
  };
};
