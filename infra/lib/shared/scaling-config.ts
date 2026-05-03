import { createEnvReader } from '@marketplace/env-parser';
import { z } from 'zod';

const scalingConfigSchema = z.object({
  // Lambda
  lambdaTimeoutSeconds: z.number(),
  lambdaMemoryMb: z.number(),
  // ASG (EC2 instances)
  asgMinCapacityDev: z.number(),
  asgMinCapacityPerf: z.number(),
  asgMaxCapacityDev: z.number(),
  asgMaxCapacityPerf: z.number(),
  ec2InstanceSizeDev: z.string(),
  ec2InstanceSizePerf: z.string(),
  // ECS tasks
  ecsTaskMinDev: z.number(),
  ecsTaskMinPerf: z.number(),
  ecsTaskMaxDev: z.number(),
  ecsTaskMaxPerf: z.number(),
  // Gateway container resources
  gatewayContainerCpu: z.number(),
  gatewayContainerMemorySoftMb: z.number(),
  gatewayContainerMemoryHardMb: z.number(),
  // ALB scaling thresholds
  albScaleReqLow: z.number(),
  albScaleReqHigh: z.number(),
  albScaleLatencyLowS: z.number(),
  albScaleLatencyHighS: z.number(),
  // Aurora
  auroraInstanceSize: z.string(),
  auroraReplicaMin: z.number(),
  auroraReplicaMax: z.number(),
  auroraReplicaCpuTarget: z.number(),
  auroraBackupRetentionDev: z.number(),
  auroraBackupRetentionPerf: z.number(),
  rdsProxyMaxConnectionsPct: z.number(),
  // Redis
  redisNodeType: z.string(),
});

export type ScalingConfig = z.infer<typeof scalingConfigSchema>;

const getScalingConfig = (): ScalingConfig => {
  const { readOptionalInt, readOptionalString } = createEnvReader(process.env);

  return scalingConfigSchema.parse({
    lambdaTimeoutSeconds: readOptionalInt('LAMBDA_TIMEOUT_SECONDS', 30),
    lambdaMemoryMb: readOptionalInt('LAMBDA_MEMORY_MB', 256),
    asgMinCapacityDev: readOptionalInt('ASG_MIN_CAPACITY_DEV', 1),
    asgMinCapacityPerf: readOptionalInt('ASG_MIN_CAPACITY_PERF', 2),
    asgMaxCapacityDev: readOptionalInt('ASG_MAX_CAPACITY_DEV', 2),
    asgMaxCapacityPerf: readOptionalInt('ASG_MAX_CAPACITY_PERF', 8),
    ec2InstanceSizeDev: readOptionalString('EC2_INSTANCE_SIZE_DEV', 'MICRO'),
    ec2InstanceSizePerf: readOptionalString('EC2_INSTANCE_SIZE_PERF', 'MEDIUM'),
    ecsTaskMinDev: readOptionalInt('ECS_TASK_MIN_DEV', 1),
    ecsTaskMinPerf: readOptionalInt('ECS_TASK_MIN_PERF', 2),
    ecsTaskMaxDev: readOptionalInt('ECS_TASK_MAX_DEV', 4),
    ecsTaskMaxPerf: readOptionalInt('ECS_TASK_MAX_PERF', 8),
    gatewayContainerCpu: readOptionalInt('GATEWAY_CONTAINER_CPU', 256),
    gatewayContainerMemorySoftMb: readOptionalInt('GATEWAY_CONTAINER_MEMORY_SOFT_MB', 256),
    gatewayContainerMemoryHardMb: readOptionalInt('GATEWAY_CONTAINER_MEMORY_HARD_MB', 512),
    albScaleReqLow: readOptionalInt('ALB_SCALE_REQ_LOW', 100),
    albScaleReqHigh: readOptionalInt('ALB_SCALE_REQ_HIGH', 200),
    albScaleLatencyLowS: readOptionalInt('ALB_SCALE_LATENCY_LOW_S', 2),
    albScaleLatencyHighS: readOptionalInt('ALB_SCALE_LATENCY_HIGH_S', 3),
    auroraInstanceSize: readOptionalString('AURORA_INSTANCE_SIZE', 'MEDIUM'),
    auroraReplicaMin: readOptionalInt('AURORA_REPLICA_MIN', 1),
    auroraReplicaMax: readOptionalInt('AURORA_REPLICA_MAX', 2),
    auroraReplicaCpuTarget: readOptionalInt('AURORA_REPLICA_CPU_TARGET', 60),
    auroraBackupRetentionDev: readOptionalInt('AURORA_BACKUP_RETENTION_DEV', 10),
    auroraBackupRetentionPerf: readOptionalInt('AURORA_BACKUP_RETENTION_PERF', 30),
    rdsProxyMaxConnectionsPct: readOptionalInt('RDS_PROXY_MAX_CONNECTIONS_PCT', 90),
    redisNodeType: readOptionalString('REDIS_NODE_TYPE', 'cache.t3.micro'),
  });
};

export const scalingConfig = getScalingConfig();
