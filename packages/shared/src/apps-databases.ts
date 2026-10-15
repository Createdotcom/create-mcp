import type { AppsSize } from './apps-hosting';

/**
 * Create App Hosting, slice A6 — managed Postgres (spec 2026-09-25 §3.9, §9.1). The definitions the
 * API, the MCP tools, the CLI and the dashboard share: versions, the extension allowlist, plan caps,
 * backup retention, and the connection variables a database exposes as `${{<db>.KEY}}` references.
 *
 * Runtime (spec §3.9): one CloudNativePG `Cluster` per database, on the TopoLVM data pool, under
 * runc (never gVisor), with a PgBouncer `Pooler` in transaction mode and the Barman Cloud plugin
 * archiving to the object store. Customers get the database OWNER role through a login role — never
 * superuser — and extensions only from the allowlist below, created by the operator.
 */

export const APPS_POSTGRES_VERSIONS = [16, 17] as const;
export type AppsPostgresVersion = (typeof APPS_POSTGRES_VERSIONS)[number];
export const APPS_POSTGRES_DEFAULT_VERSION: AppsPostgresVersion = 17;

/**
 * Extensions a customer may enable (spec §3.9: "pgvector, PostGIS, pg_trgm, uuid-ossp, citext,
 * hstore, pg_stat_statements, …"). Created by the CloudNativePG operator through a declarative
 * `Database` resource, so the customer's role never needs CREATE EXTENSION on an untrusted one.
 * Everything here ships in the `create-postgres` image catalog (ops step: the catalog's images are the
 * CloudNativePG "standard" images plus PostGIS). Anything else is refused by the API and again by the
 * cluster agent. Untrusted languages (plpython3u, plperlu), file access (file_fdw, adminpack) and
 * anything that reaches the network (dblink, postgres_fdw) are deliberately absent.
 */
export const APPS_POSTGRES_EXTENSIONS = [
  'vector',
  'postgis',
  'postgis_topology',
  'pg_trgm',
  'uuid-ossp',
  'citext',
  'hstore',
  'pgcrypto',
  'pg_stat_statements',
  'btree_gin',
  'btree_gist',
  'unaccent',
  'fuzzystrmatch',
  'ltree',
  'intarray',
  'cube',
  'earthdistance',
  'tablefunc',
  'isn',
  'pg_prewarm',
] as const;
export type AppsPostgresExtension = (typeof APPS_POSTGRES_EXTENSIONS)[number];

/** The lifecycle a database walks through (`apps_databases.status`). */
export const APPS_DATABASE_STATUSES = ['provisioning', 'ready', 'updating', 'failed', 'deleting', 'deleted'] as const;
export type AppsDatabaseStatus = (typeof APPS_DATABASE_STATUSES)[number];

/**
 * The connection variables every database exposes to the other services of its environment, by
 * reference only: `${{db.DATABASE_URL}}`. They are never stored as variable rows and never returned
 * by a plain API response; they resolve (sealed) into a deployment's snapshot at deploy time.
 * `DATABASE_URL` goes through the PgBouncer pooler in TRANSACTION mode (no session state, no
 * prepared statements across transactions); `DATABASE_URL_UNPOOLED` goes to the primary directly
 * (migrations, LISTEN/NOTIFY, advisory locks).
 */
export const APPS_DATABASE_VARIABLES = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'PGHOST', 'PGHOST_UNPOOLED', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;
export type AppsDatabaseVariable = (typeof APPS_DATABASE_VARIABLES)[number];
/** Which of the above carry the password (sealed, secret-tainting whatever references them). */
export const APPS_DATABASE_SECRET_VARIABLES: readonly AppsDatabaseVariable[] = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'PGPASSWORD'];

/** The database and owner role inside every managed cluster. */
export const APPS_POSTGRES_DATABASE = 'app';
export const APPS_POSTGRES_OWNER = 'app';
/** The two login roles credentials alternate between (rotation without downtime). */
export const APPS_POSTGRES_LOGIN_ROLES = ['app_a', 'app_b'] as const;

/**
 * Plan caps (spec §9.1: Hobby "1 × Postgres 256 MB / 1 GB storage, daily backup"; Pro "any size, HA
 * option, PITR"). Numbers are technical ceilings that match the tenant namespace quota
 * (infra/app-cluster/tenant-template: Hobby 1 PVC / 1 Gi, Pro 10 PVCs / 100 Gi); prices are the
 * founder's (§14). `maxInstancesPerEnvironment` counts every database instance (one PVC each).
 */
export const APPS_DATABASE_PLAN_CAPS = {
  hobby: {
    sizes: ['S'] as readonly AppsSize[],
    maxStorageGb: 1,
    maxEnvironmentStorageGb: 1,
    maxInstancesPerEnvironment: 1,
    maxDatabasesPerEnvironment: 1,
    ha: false,
    pitr: false,
    retentionDays: { min: 7, max: 7, default: 7 },
    publicAccess: false,
  },
  pro: {
    sizes: ['S', 'M', 'L', 'XL', '2XL', '4XL'] as readonly AppsSize[],
    maxStorageGb: 100,
    maxEnvironmentStorageGb: 100,
    maxInstancesPerEnvironment: 10,
    maxDatabasesPerEnvironment: 5,
    ha: true,
    pitr: true,
    retentionDays: { min: 7, max: 30, default: 14 },
    publicAccess: true,
  },
} as const;
export type AppsDatabasePlanCaps = (typeof APPS_DATABASE_PLAN_CAPS)[keyof typeof APPS_DATABASE_PLAN_CAPS];

/** HA means a primary plus one or two standbys (automatic failover). */
export const APPS_DATABASE_HA_INSTANCES = { min: 2, max: 3, default: 2 } as const;

/** How long a deleted database is kept (restorable with one call) before it is torn down. */
export const APPS_DATABASE_DELETE_GRACE_DAYS = 7;
/** How long the final backup taken at deletion is kept in the object store after teardown. */
export const APPS_DATABASE_FINAL_BACKUP_DAYS = 30;
/** How long a rotated-out login keeps working, so running services can be redeployed first. */
export const APPS_DATABASE_ROTATION_GRACE_HOURS = 24;

/** `create db connect`: temporary, IP-bound credentials. */
export const APPS_DATABASE_CONNECT = { defaultMinutes: 15, maxMinutes: 60, maxActivePerDatabase: 5, connectionLimit: 3 } as const;
/** Public access (off by default): an explicit allowlist, never the whole internet. */
export const APPS_DATABASE_PUBLIC_MAX_CIDRS = 20;

/** Postgres settings per size: connections and memory (shared_buffers ≈ 25%, effective_cache_size ≈ 75%). */
export const APPS_DATABASE_SIZE_SETTINGS: Readonly<Record<AppsSize, { maxConnections: number; poolSize: number }>> = {
  S: { maxConnections: 50, poolSize: 10 },
  M: { maxConnections: 100, poolSize: 20 },
  L: { maxConnections: 200, poolSize: 40 },
  XL: { maxConnections: 300, poolSize: 60 },
  '2XL': { maxConnections: 400, poolSize: 80 },
  '4XL': { maxConnections: 500, poolSize: 100 },
};

/** Usage meters A6 writes for A8 (spec §9.2): per database per hour. */
export const APPS_DATABASE_METERS = ['compute_size_hours', 'storage_gb_hours', 'backup_gb_hours'] as const;
