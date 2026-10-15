/**
 * Create App Hosting, slice A2 (spec 2026-09-25 §2.2, §10.2). The capability matrix rows this
 * product adds to the account dashboard's matrix, the role defaults, the size ladder, and the
 * agent protocol's version. Shared so the API, the dashboard and (later) the curated hosting MCP
 * read one definition.
 *
 * There is NO agency or client layer for this product (founder correction 2026-09-25): the
 * `client_access` role holds no apps capability, and no delegation grants one.
 */

export const APPS_CAPABILITIES = [
  'apps.view',
  'apps.deploy',
  'apps.configure',
  'apps.secrets.read',
  'apps.data.admin',
  'apps.delete',
  'apps.tokens',
] as const;
export type AppsCapability = (typeof APPS_CAPABILITIES)[number];

/** The shared-account roles (account dashboard spec 2026-09-23), as strings: the account slice owns the type. */
export const APPS_ACCOUNT_ROLES = ['owner', 'administrator', 'billing', 'staff', 'client_access'] as const;
export type AppsAccountRole = (typeof APPS_ACCOUNT_ROLES)[number];

/**
 * §2.2. Owner and Administrator hold everything, including revealing secrets. Billing sees usage,
 * caps and invoices and never variables, logs or credentials — none of which A2 serves — so it holds
 * no apps capability here. Staff default to viewing; per-project assignment (§2.2 "Staff can be
 * assigned per project") is a later grant, not a role default.
 */
export const APPS_ROLE_CAPABILITIES: Readonly<Record<AppsAccountRole, readonly AppsCapability[]>> = {
  owner: APPS_CAPABILITIES,
  administrator: APPS_CAPABILITIES,
  billing: [],
  staff: ['apps.view'],
  client_access: [],
};

export function appsCapabilitiesFor(role: string): readonly AppsCapability[] {
  return (APPS_ROLE_CAPABILITIES as Record<string, readonly AppsCapability[] | undefined>)[role] ?? [];
}

/** §9.1 size ladder (prices are founder-only; only the shape is fixed here). */
export const APPS_SIZES = ['S', 'M', 'L', 'XL', '2XL', '4XL'] as const;
export type AppsSize = (typeof APPS_SIZES)[number];

/** Requests and limits per size (§3.2: memory request = limit; shared sizes request a quarter of the CPU limit). */
export const APPS_SIZE_RESOURCES: Readonly<Record<AppsSize, { cpuLimitMillis: number; cpuRequestMillis: number; memoryMiB: number }>> = {
  S: { cpuLimitMillis: 500, cpuRequestMillis: 125, memoryMiB: 512 },
  M: { cpuLimitMillis: 1000, cpuRequestMillis: 250, memoryMiB: 1024 },
  L: { cpuLimitMillis: 2000, cpuRequestMillis: 500, memoryMiB: 2048 },
  XL: { cpuLimitMillis: 2000, cpuRequestMillis: 2000, memoryMiB: 4096 },
  '2XL': { cpuLimitMillis: 4000, cpuRequestMillis: 4000, memoryMiB: 8192 },
  '4XL': { cpuLimitMillis: 8000, cpuRequestMillis: 8000, memoryMiB: 16384 },
};

/** The service kinds A2 deploys (image-sourced containers). The rest arrive with their slices. */
export const APPS_A2_SERVICE_KINDS = ['web', 'worker'] as const;

/** The regions a project can be created in until the region list comes from `apps_clusters`. */
export const APPS_REGION_PATTERN = /^[a-z]{2,8}(-[a-z0-9]{1,12}){0,3}$/;

/**
 * The agent protocol (§10.2) is versioned independently of the Admin API's date version: the Go
 * agent pins one, the control plane serves every version it lists here, and anything else is
 * refused with the list so an old agent can say exactly what it needs.
 */
export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_PROTOCOL_SUPPORTED: readonly number[] = [1];

// ---------------------------------------------------------------------------------------------
// Slice A3 — builds (spec §3.3, §5.2, §8.3, §8.6)
// ---------------------------------------------------------------------------------------------

/**
 * Railpack (MIT, github.com/railwayapp/railpack), pinned. The build pod's `railpack` binary and the
 * BuildKit frontend image MUST be the same version ("use the same version of the frontend that was
 * used to generate the build plan", railpack.com/platforms/running-railpack-in-production).
 */
export const RAILPACK_VERSION = '0.40.0';
/** Pinned by digest as well as tag (read from ghcr.io on 2026-09-26): the frontend runs inside every build. */
export const RAILPACK_FRONTEND_IMAGE = `ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}@sha256:fc6d5fa434c9310500dc18bebb0a4eb4854fee8546a6d7a090e7a36e39d9d153`;

/** How the build pod turns source into an image. `auto` = a Dockerfile if the source has one, else Railpack. */
export const APPS_BUILDERS = ['auto', 'railpack', 'dockerfile'] as const;
export type AppsBuilder = (typeof APPS_BUILDERS)[number];

export const APPS_BUILD_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AppsBuildStatus = (typeof APPS_BUILD_STATUSES)[number];

/** The steps a build walks through, in order. A failure names the step it happened in. */
export const APPS_BUILD_PHASES = ['queued', 'fetching', 'planning', 'building', 'pushing', 'done'] as const;
export type AppsBuildPhase = (typeof APPS_BUILD_PHASES)[number];

/**
 * §3.3 limits. The timeout is the plan's (20 min default; Pro 45 arrives with plans in A8); CPU,
 * memory and scratch are per build pod. Upload caps protect the control plane before any build pod
 * sees the bytes.
 */
export const APPS_BUILD_LIMITS = {
  timeoutSeconds: 20 * 60,
  proTimeoutSeconds: 45 * 60,
  cpuMillis: 4000,
  memoryMiB: 8192,
  scratchGiB: 10,
  /** Stored log bytes per build (after redaction); beyond this the log is truncated and says so. */
  maxLogBytes: 5 * 1024 * 1024,
  maxLogLineChars: 4000,
  /** Builds of one account running at once on one cluster (fairness, abuse). */
  maxRunningPerAccount: 2,
  /** Builds of one account waiting in the queue; more are refused until some finish. */
  maxQueuedPerAccount: 10,
  /** A build's registry robot: minted per lease, deleted when the build ends; Harbor counts in days. */
  robotLifetimeDays: 1,
} as const;

export const APPS_UPLOAD_LIMITS = {
  /** A compressed `.tar.gz` upload. */
  maxBytes: 200 * 1024 * 1024,
  /** Everything the archive unpacks to. */
  maxUnpackedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxEntries: 50_000,
  maxPathLength: 1024,
  maxDepth: 64,
  /** An upload that is not used by a build within this window is discarded. */
  ttlSeconds: 24 * 60 * 60,
  /** Uploads of one account receiving bytes at once (all API instances). */
  maxConcurrentPerAccount: 2,
  /** Uploads receiving bytes at once on one API instance (all accounts). */
  maxConcurrentPerInstance: 8,
  /** A receiving upload older than this is abandoned (the client went away mid-PUT). */
  receivingStaleSeconds: 15 * 60,
  /** Per account, rolling 24 hours: uploads started and bytes declared. */
  dailyCount: 200,
  dailyBytes: 5 * 1024 * 1024 * 1024,
  /** Per account, rolling hour: uploads started. */
  hourlyCount: 30,
} as const;
