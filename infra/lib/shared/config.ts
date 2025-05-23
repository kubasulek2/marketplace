import dotenv from 'dotenv';
import { z } from 'zod';

import { createEnvReader } from '@marketplace/env-parser';

dotenv.config({ path: '.env.local' });

const appConfigSchema = z.object({
  useAuth: z.boolean(),
  usePrivateNetworks: z.boolean(),
  deployEnv: z.enum(['dev', 'prod']),
  project: z.string(),
  performanceMode: z.boolean(),
});

const stackConfigSchema = z.object({
  env: z.object({
    account: z.string(),
    region: z.string(),
  }),
});

export type StackConfig = z.infer<typeof stackConfigSchema>;

export type AppConfig = z.infer<typeof appConfigSchema>;

const getAppConfig = (): AppConfig => {
  const { readOptionalBool, readRequiredString } = createEnvReader(process.env);

  return appConfigSchema.parse({
    useAuth: readOptionalBool('USE_AUTH', true),
    usePrivateNetworks: readOptionalBool('USE_PRIVATE_NETWORKS', true),
    performanceMode: readOptionalBool('PERFORMANCE_MODE', true),
    deployEnv: readRequiredString('DEPLOY_ENV'),
    project: 'marketplace',
  });
};
const getStackConfig = (): StackConfig => {
  const { readRequiredString } = createEnvReader(process.env);

  return stackConfigSchema.parse({
    env: {
      account: readRequiredString('CDK_DEFAULT_ACCOUNT'),
      region: readRequiredString('CDK_DEFAULT_REGION'),
    },
  });
};
export const appConfig = getAppConfig();
export const stackConfig = getStackConfig();
