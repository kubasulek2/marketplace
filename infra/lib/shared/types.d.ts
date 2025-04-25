export type AppEnvironment = 'dev' | 'prod';

export interface DeploymentContext {
  /**
   * Environment name (e.g., 'dev', 'staging', 'prod')
   */
  environment: AppEnvironment;

  /**
   * Project name used for resource naming and tagging
   */
  project: string;
}
