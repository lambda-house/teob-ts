export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxPoolSize: number;
  applicationName: string;
}

export function postgresConfigFromEnv(defaults?: Partial<PostgresConfig>): PostgresConfig {
  return {
    host: process.env.POSTGRES_HOST ?? defaults?.host ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? defaults?.port ?? 5432),
    database: process.env.POSTGRES_DATABASE ?? defaults?.database ?? "postgres",
    user: process.env.POSTGRES_USERNAME ?? defaults?.user ?? "postgres",
    password: process.env.POSTGRES_PASSWORD ?? defaults?.password ?? "postgres",
    maxPoolSize: Number(process.env.POSTGRES_POOL_SIZE ?? defaults?.maxPoolSize ?? 10),
    applicationName: defaults?.applicationName ?? "teob-ts",
  };
}
