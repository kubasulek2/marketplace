import { getEnvironment } from './environment';

export const getEnvSpecificName = (name: string) => {
  const { context } = getEnvironment();
  return `${context.project}-${context.environment}-${name}`;
};
