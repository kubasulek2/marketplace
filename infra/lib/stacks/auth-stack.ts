import { Stack, StackProps } from 'aws-cdk-lib';
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { DeploymentContext } from '../shared/types';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface AuthStackProps extends StackProps {
  restApi: RestApi;
  authDnsRecord: string;
  context: DeploymentContext;
}
export class AuthStack extends Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const userPool = new UserPool(this, 'UserPool', {
      userPoolName: getEnvSpecificName('UserPool'),
    });
  }
}
