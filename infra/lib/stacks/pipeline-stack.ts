import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { AppConfig, StackEnvConfig } from '../shared/config';
import { getEnvSpecificName } from '../shared/getEnvSpecificName';

export interface PipelineStackProps extends cdk.StackProps {
  config: AppConfig;
  env: StackEnvConfig;
  codeStarConnectionArn: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: getEnvSpecificName('pipeline-artifacts'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: getEnvSpecificName('BuildProject'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // required for Docker (gateway image build)
      },
      environmentVariables: {
        DEPLOY_ENV: { value: props.config.deployEnv },
        CDK_DEFAULT_ACCOUNT: { value: props.env.account },
        CDK_DEFAULT_REGION: { value: props.env.region },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.minutes(30),
    });

    // Grant AdministratorAccess so CodeBuild can run cdk deploy for all stacks
    buildProject.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );

    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub_Source',
      owner: props.githubOwner,
      repo: props.githubRepo,
      branch: props.githubBranch,
      connectionArn: props.codeStarConnectionArn,
      output: sourceOutput,
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Typecheck_And_Deploy',
      project: buildProject,
      input: sourceOutput,
    });

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: getEnvSpecificName('Pipeline'),
      artifactBucket,
      stages: [
        { stageName: 'Source', actions: [sourceAction] },
        { stageName: 'Build_And_Deploy', actions: [buildAction] },
      ],
    });
  }
}
