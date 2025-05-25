import { createEnvReader } from '@marketplace/env-parser';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: '.env.local' });

const appConfigSchema = z.object({
  useAuth: z.boolean(),
  usePrivateSubnets: z.boolean(),
  performanceMode: z.boolean(),
  deployEnv: z.enum(['dev', 'prod']),
  project: z.string(),
  services: z.object({
    products: z.boolean(),
    orders: z.boolean(),
    inventory: z.boolean(),
    payments: z.boolean(),
    auth: z.boolean(),
  }),
});

const stackEnvConfigSchema = z.object({
  account: z.string(),
  region: z.string(),
});

export type StackEnvConfig = z.infer<typeof stackEnvConfigSchema>;

export type AppConfig = z.infer<typeof appConfigSchema>;

const getAppConfig = (): AppConfig => {
  const { readOptionalBool, readRequiredString } = createEnvReader(process.env);

  return appConfigSchema.parse({
    useAuth: readOptionalBool('USE_AUTH', true),
    usePrivateSubnets: readOptionalBool('USE_PRIVATE_SUBNETS', true),
    performanceMode: readOptionalBool('PERFORMANCE_MODE', true),
    deployEnv: readRequiredString('DEPLOY_ENV'),
    project: 'marketplace',
    services: {
      products: readOptionalBool('SERVICES_PRODUCTS', true),
      orders: readOptionalBool('SERVICES_ORDERS', true),
      inventory: readOptionalBool('SERVICES_INVENTORY', true),
      payments: readOptionalBool('SERVICES_PAYMENTS', true),
      auth: readOptionalBool('SERVICES_AUTH', true),
    },
  });
};

const getStackEnvConfig = (): StackEnvConfig => {
  const { readRequiredString } = createEnvReader(process.env);

  return stackEnvConfigSchema.parse({
    account: readRequiredString('CDK_DEFAULT_ACCOUNT'),
    region: readRequiredString('CDK_DEFAULT_REGION'),
  });
};

export const appConfig = getAppConfig();
export const stackEnvConfig = getStackEnvConfig();
