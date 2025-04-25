import { Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { DeploymentContext } from '../shared/types';

export interface AppStackProps extends StackProps {
  context: DeploymentContext;
  vpc: ec2.Vpc;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
  }
}
