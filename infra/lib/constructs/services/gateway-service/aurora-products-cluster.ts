import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export type AuroraProductClusterProps = {
  vpc: ec2.Vpc;
};

export class AuroraProductCluster extends Construct {
  constructor(scope: Construct, id: string, props: AuroraProductClusterProps) {
    super(scope, id);

    // how to  pass your password here?
    const credentials = new rds.DatabaseSecret(this, 'DBCredentials', {
      username: 'admin',
    });

    const cluster = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
      instances: 1,
      credentials: rds.Credentials.fromSecret(credentials),
      vpc: props.vpc,
    });

    const setupSQL = `
      CREATE SCHEMA IF NOT EXISTS my_app_schema;
      CREATE USER my_app_user WITH PASSWORD 'my_password';
      GRANT ALL PRIVILEGES ON SCHEMA my_app_schema TO my_app_user;
    `;

    new cr.AwsCustomResource(this, 'DBSetup', {
      onCreate: {
        service: 'RDSDataService',
        action: 'executeStatement',
        parameters: {
          secretArn: credentials.secretArn,
          resourceArn: cluster.clusterArn,
          sql: setupSQL,
          database: 'postgres',
        },
        physicalResourceId: cr.PhysicalResourceId.of('DBSetup'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [cluster.clusterArn, credentials.secretArn],
      }),
    });
  }
}
