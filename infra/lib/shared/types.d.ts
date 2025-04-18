export interface DeploymentContext {
  /**
   * Environment name (e.g., 'dev', 'staging', 'prod')
   */
  environment: 'dev' | 'staging' | 'prod';

  /**
   * Project name used for resource naming and tagging
   */
  project: string;
}
