import { appConfig } from './config';

export const getEnvSpecificName = (name: string) => {
  return `${appConfig.project}-${appConfig.deployEnv}-${name}`;
};
