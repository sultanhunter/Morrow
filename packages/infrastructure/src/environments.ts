export const environmentNames = ["development", "staging", "production"] as const;
export type EnvironmentName = (typeof environmentNames)[number];
export interface EnvironmentDefinition {
  name: EnvironmentName;
  region: "us-east-1";
  temporalRegion: "aws-us-east-1";
  availabilityZones: 2;
  databaseInstances: 1 | 2;
  minimumAcu: 0.5;
  backupDays: 7 | 35;
  logDays: 14;
  temporalClosedDays: 7 | 30;
  dispatch: "disabled";
}
export const environments: Readonly<Record<EnvironmentName, EnvironmentDefinition>> = {
  development: {
    name: "development",
    region: "us-east-1",
    temporalRegion: "aws-us-east-1",
    availabilityZones: 2,
    databaseInstances: 1,
    minimumAcu: 0.5,
    backupDays: 7,
    logDays: 14,
    temporalClosedDays: 7,
    dispatch: "disabled",
  },
  staging: {
    name: "staging",
    region: "us-east-1",
    temporalRegion: "aws-us-east-1",
    availabilityZones: 2,
    databaseInstances: 1,
    minimumAcu: 0.5,
    backupDays: 7,
    logDays: 14,
    temporalClosedDays: 7,
    dispatch: "disabled",
  },
  production: {
    name: "production",
    region: "us-east-1",
    temporalRegion: "aws-us-east-1",
    availabilityZones: 2,
    databaseInstances: 2,
    minimumAcu: 0.5,
    backupDays: 35,
    logDays: 14,
    temporalClosedDays: 30,
    dispatch: "disabled",
  },
};

export function environment(name: string): EnvironmentDefinition {
  if (!environmentNames.includes(name as EnvironmentName)) throw Error("UNKNOWN_ENVIRONMENT");
  return environments[name as EnvironmentName];
}
