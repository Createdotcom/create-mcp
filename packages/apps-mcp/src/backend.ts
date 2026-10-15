/**
 * What the hosting tools need from Create, task-shaped rather than REST-shaped. Two implementations:
 *
 * - IN-PROCESS (apps/api `apps-hosting/publishing/agent-api.ts`): the remote MCP endpoint calls the
 *   service layer directly with the grant's access, so scope, spend and size rules are the same
 *   functions the REST routes run.
 * - HTTP (`http-backend.ts`): the `create` CLI and `create mcp` (stdio) call `/v1/apps/*` with the
 *   CLI's stored token.
 *
 * Types mirror the API's JSON views (apps/api/src/apps-hosting/service.ts) with only the fields the
 * tools read.
 */

export type Environment = { id: string; name: string; kind: string };

export type Service = {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  kind: string;
  /** Null for a service built from source until its first build succeeds (A3). */
  image: string | null;
  size: string;
  replicas: number;
  port: number | null;
  currentDeploymentId: string | null;
  observed: { readyReplicas: number | null; deploymentId: string | null };
  /** E1: an edge frontend's URL and hostnames; absent/null for container services. */
  edge?: { url: string | null; hostnames: { hostname: string; kind: string; status: string }[] } | null;
};

export type Project = {
  id: string;
  accountId: string;
  name: string;
  region: string;
  /**
   * Fixed at creation: the project has a compute/build cluster. False = edge-only (prebuilt edge bundles
   * only; a framework source folder must be built on the caller's machine first). Absent from older APIs.
   */
  supportsCompute?: boolean;
  status: 'active' | 'deleting' | 'deleted';
  createdAt: string;
  environments: Environment[];
  services: Service[];
};

export type ProjectListItem = Omit<Project, 'environments' | 'services'> & { serviceCount: number };

export type Deployment = {
  id: string;
  projectId: string;
  serviceId: string;
  /** `building` (A3): deployed from source, waiting for its build to hand over the image digest. */
  status: 'building' | 'queued' | 'deploying' | 'verifying' | 'live' | 'failed' | 'superseded' | 'cancelled';
  image: string;
  rollbackOf: string | null;
  failure: { failedStep: string; message: string } | null;
  readyReplicas: number | null;
  current: boolean;
  createdAt: string;
  liveAt: string | null;
};

export type DeployAccepted = {
  deployment: Deployment;
  operation: { id: string; status: string };
  statusUrl: string;
  replayed: boolean;
  /**
   * E2: a deploy from source says where it runs and why — the framework detector's verdict on the
   * source, or the caller's explicit `target` (§7.6). Absent for image deploys and rollbacks.
   */
  target?: 'edge' | 'container';
  framework?: string | null;
  reason?: string;
  overridden?: boolean;
  warnings?: string[];
  /** E2: an edge frontend's address (serving once its build is deployed). */
  url?: string | null;
};

/** E2: where a deploy from source runs — the detector's choice, or an explicit override. */
export type TargetChoice = 'auto' | 'edge' | 'container';
export type SourceDeployOptions = { target?: TargetChoice; framework?: string | null; /** E3: deploy an edge frontend as a preview of this branch (never production). */ preview?: { branch: string | null } | null };

/** E1: an edge deploy is synchronous — live (or refused) when the call returns — and has a URL. */
export type EdgeDeployAccepted = DeployAccepted & {
  url: string | null;
  hostnames: string[];
  version: { scriptBytes: number; assetCount: number; assetBytes: number; uploadedAssets: number };
  /** E3: this deployment's own immutable address. */
  deploymentUrl?: string | null;
  /** E3: production is pinned by a rollback: ready at deploymentUrl, not live until promoted. */
  staged?: boolean;
  /** E3: a preview deploy — which preview, and the production secrets it did not get. */
  preview?: { id: string; branch: string; environmentId: string; withheld: string[] };
};

/** E3: the answer to a promotion. */
export type PromoteAccepted = EdgeDeployAccepted & { promotedFrom: string; mode: 'activate' | 'copy' | 'unpin' };

/** E3: a direct (CLI/MCP/API) preview. */
export type EdgePreview = {
  id: string;
  /** The preview environment the branch deploys into (`create status` labels its services with the branch). */
  environmentId?: string;
  branch: string;
  status: 'open' | 'closed';
  url: string | null;
  lastDeploymentId: string | null;
  lastDeploymentUrl: string | null;
  lastDeployAt: string;
  expiresAt: string | null;
};

/** E3: a project's edge usage this month. */
export type EdgeUsage = {
  projectId: string;
  month: string;
  plan: 'hobby' | 'pro';
  hardCap: boolean;
  meters: Record<'requests' | 'cpuMs' | 'bytes', { used: number; included: number; percent: number }>;
  paused: { until: string } | null;
  alerts: { meter: string; threshold: number; at: string }[];
  metering: boolean;
};

export type EdgeHostname = {
  id: string;
  serviceId: string;
  hostname: string;
  kind: 'default' | 'custom';
  /** A4: `container` for a web service's hostname (routed by the cluster gateway), `edge` for a frontend's. */
  tier?: 'edge' | 'container';
  status: 'awaiting_ownership' | 'pending' | 'active' | 'failed' | 'removing';
  sslStatus: string | null;
  verification: { type: 'TXT' | 'CNAME'; name: string; value: string }[];
  lastError: string | null;
  expiresAt?: string | null;
};

/**
 * A bare (apex) domain (example.com) that Create's apex gateway redirects to one of the service's custom
 * hostnames — self-serve Cloudflare has no apex proxying. `records` is every DNS record to create.
 */
export type ApexDomain = {
  id: string;
  hostname: string;
  redirectTo: string;
  status: 'awaiting_ownership' | 'pending' | 'active';
  mode: 'gateway' | 'cloudflare' | 'unavailable';
  hsts: boolean;
  hstsMaxAge: number;
  ownershipVerified: boolean;
  dns: { status: 'unchecked' | 'pointing' | 'not_pointing'; expected: { a: string[]; aaaa: string[] }; seen: string[]; checkedAt: string | null };
  certificate: { status: 'none' | 'issued' | 'failed'; issuer: string | null; notAfter: string | null; error: string | null };
  records: { type: 'TXT' | 'A' | 'AAAA' | 'CNAME'; name: string; value: string; purpose: string }[];
  lastError: string | null;
  expiresAt: string | null;
  createdAt: string;
};
export type ApexDomainInput = { hostname: string; redirectTo?: string; hsts?: boolean };

export type Whoami = {
  caller: 'session' | 'grant';
  userId: string;
  accounts: { accountId: string; capabilities: string[] }[];
  grant: {
    id: string;
    clientName: string;
    accountId: string;
    projectScope: 'created' | 'selected' | 'account';
    projectIds: string[];
    scopes: string[];
    spendLimitCents: number;
    runRateCents: number;
    sizeCeiling: string;
    expiresAt: string;
  } | null;
};

/** A8: the account's spending limit and where the month stands against it. */
export type BillingCap = { enabled: boolean; amount: number | null; editable: boolean; defaultAmount: number };
export type BillingSpending = { state: 'ok' | 'warning' | 'blocked' | 'paused'; month: string; spent: number; projected: number; reserved: number; evaluatedAt: string | null };
export type BillingPlanSummary = {
  id: 'free' | 'pro' | 'team';
  name: string;
  monthlyAmount: number;
  currency: string;
  memberLimit: number | null;
  projectTier: 'hobby' | 'pro';
  defaultCapAmount: number;
  capEditable: boolean;
  allowances: { meter: string; label: string; included: number; includedDisplay: string; overage: { unitAmount: number; unitDivisor: number } | null }[];
};

/** A8: `GET /v1/apps/billing/usage`. Money is USD cents. */
export type BillingUsage = {
  accountId: string;
  month: string;
  plan: 'free' | 'pro' | 'team';
  scope: 'account' | 'projects';
  meters: { meter: string; label: string; group: string; quantity: number; included: number; overage: number; amount: number; percentOfAllowance: number | null; display: { quantity: string; included: string } }[];
  usageAmount: number;
  cap: BillingCap;
  spending: BillingSpending;
  projects: { projectId: string; name: string; spend: number; spendCap: number | null; paused: 'account_cap' | 'project_cap' | 'unpaid' | null; meters: Record<string, number> }[];
  grants: { grantId: string; clientName: string; spend: number; meters: Record<string, number> }[];
  notices: { scope: string; threshold: number; month: string; spent: number; cap: number; at: string }[];
};

/** A8: `GET /v1/apps/billing/plan`. */
export type BillingPlanView = {
  accountId: string;
  plan: BillingPlanSummary;
  pendingPlan: 'free' | 'pro' | 'team' | null;
  members: { count: number; limit: number | null };
  cap: BillingCap;
  spending: BillingSpending;
  pausedProjects: { projectId: string; name: string; reason: 'account_cap' | 'project_cap' | 'unpaid' }[];
  plans: BillingPlanSummary[];
};

/** A8: `PUT /v1/apps/billing/plan`. */
export type BillingPlanChange = {
  plan: 'free' | 'pro' | 'team';
  pendingPlan: 'free' | 'pro' | 'team' | null;
  effective: 'now' | 'end_of_month' | 'unchanged';
  invoice: { id: string; number: string; amount: number } | null;
  message: string;
  view: BillingPlanView;
};

/** A8: `GET /v1/apps/billing/invoice-preview`. */
export type InvoicePreview = {
  accountId: string;
  month: string;
  plan: 'free' | 'pro' | 'team';
  nextPlan: 'free' | 'pro' | 'team';
  currency: string;
  issuesOn: string;
  lines: { kind: 'recurring' | 'usage'; description: string; meter: string | null; quantity: number; amount: number }[];
  usageToDate: number;
  projectedUsage: number;
  subtotal: number;
  taxNote: string;
};
/** A5: a persistent volume (`GET /v1/apps/volumes/{id}`). */
export type Volume = {
  id: string;
  projectId: string;
  environmentId: string;
  serviceId: string | null;
  name: string;
  sizeGb: number;
  mountPath: string;
  status: 'provisioning' | 'ready' | 'resizing' | 'failed' | 'deleting' | 'deleted';
  stillMountedBy: string | null;
  lastScheduledSnapshotAt: string | null;
  deleteAfter: string | null;
  lastError: string | null;
};

/** A5: one backup of a volume. */
export type VolumeSnapshot = { id: string; volumeId: string; name: string; kind: 'scheduled' | 'manual' | 'final'; status: 'pending' | 'ready' | 'failed' | 'deleting' | 'deleted'; sizeBytes: number | null; expiresAt: string | null; createdAt: string };

/** A5: a managed Valkey (`GET /v1/apps/valkey/{id}`). Never its password: `references` are what services set. */
export type Valkey = {
  id: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  name: string;
  size: string;
  storageGb: number;
  evictionPolicy: string;
  status: 'provisioning' | 'ready' | 'updating' | 'failed' | 'deleting' | 'deleted';
  references: Record<string, string>;
  deleteAfter: string | null;
};

/** A5: one encrypted RDB backup of a Valkey in the project's own backup bucket. */
export type ValkeyBackup = {
  id: string;
  valkeyId: string;
  kind: 'scheduled' | 'manual' | 'final';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'deleting' | 'deleted';
  sizeBytes: number | null;
  completedAt: string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
};

export type VolumeInput = { name: string; sizeGb: number; mountPath: string; serviceId?: string | null; environmentId?: string };
export type ValkeyInput = { name: string; size: string; storageGb?: number; evictionPolicy?: string; environmentId?: string };

/** E5: a project's image optimization settings (`GET /v1/apps/projects/{id}/images`). */
export type ImageSettings = {
  projectId: string;
  enabled: boolean;
  endpoint: string;
  domains: string[];
  plan: 'hobby' | 'pro';
  quota: { monthlyTransforms: number; perMinute: number };
  usage: { month: string; transforms: number; remaining: number };
  limits: { maxSourceBytes: number; maxSourceSide: number; maxPatterns: number };
};

/** E6: a project's Web Analytics opt-in, quota and usage (`GET /v1/apps/projects/{id}/analytics/settings`). */
export type AnalyticsSettings = {
  projectId: string;
  enabled: boolean;
  available: boolean;
  plan: 'hobby' | 'pro';
  quota: { monthlyEvents: number; retentionDays: number };
  usage: { month: string; events: number; dropped: number; quota: number; remaining: number; overQuota: boolean };
  script: string;
  collector: string;
  snippet: string;
  docsUrl: string;
};

export type AnalyticsTopRow = { value: string; pageviews: number; visitors: number };

/** E7: how an address kind is protected. */
export type ProtectionMode = 'off' | 'account' | 'password' | 'link';
export type ProtectionModes = { previews: ProtectionMode; deployments: ProtectionMode; production: ProtectionMode };

/** E7: `GET /v1/apps/projects/{id}/protection` (never a password or a secret). */
export type ProtectionSettings = {
  projectId: string;
  available: boolean;
  defaults: boolean;
  generation: number;
  modes: ProtectionModes;
  preflight: 'refuse' | 'pass';
  password: { set: boolean; setAt: string | null };
  bypass: { set: boolean; hint: string | null; rotatedAt: string | null; header: string };
  links: { active: number; max: number; parameter: string };
  enforced: boolean;
  coverage: 'edge_frontends';
  notice: string | null;
  docsUrl: string;
};

export type ProtectionChange = Partial<ProtectionModes> & { preflight?: 'refuse' | 'pass' };

/** E7: a shareable preview link (its token is only in the creation result). */
export type ShareLink = {
  id: string;
  label: string | null;
  scope: 'previews' | 'all';
  hostname: string | null;
  status: 'active' | 'expired' | 'revoked' | 'used_up';
  expiresAt: string;
  maxViews: number | null;
  views: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** E7b: one comment of a preview comment thread (plain text — show it as text). */
export type PreviewComment = {
  id: string;
  threadId: string;
  body: string;
  author: { userId: string | null; name: string };
  createdAt: string;
  mine: boolean;
  canDelete: boolean;
  screenshot: { id: string; type: string; bytes: number } | null;
};

/** E7b: a comment thread pinned to a page (and element) of a preview. */
export type PreviewCommentThread = {
  id: string;
  host: string;
  path: string;
  selector: string | null;
  x: number | null;
  y: number | null;
  viewportWidth: number;
  viewportHeight: number;
  deploymentId: string | null;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
  resolvedBy: string | null;
  comments: PreviewComment[];
  createdAt: string;
  updatedAt: string;
};

export type PreviewCommentQuery = { status?: 'open' | 'resolved' | 'all'; path?: string; host?: string; limit?: number };

export type ShareLinkInput = { label?: string; hostname?: string; expiresInHours?: number; maxViews?: number; scope?: 'previews' | 'all' };
export type ShareLinkCreated = { link: ShareLink; token: string; url: string | null; query: string };

/** N1: one condition set of a firewall rule (every present condition must match; any value of one matches). */
export type FirewallMatch = {
  ips?: string[];
  countries?: string[];
  asns?: number[];
  paths?: string[];
  exactPaths?: string[];
  methods?: string[];
  hostnames?: string[];
  headers?: string[];
  missingHeaders?: string[];
};
export type FirewallRuleInput = { id?: string; name: string; action: 'allow' | 'deny' | 'challenge' | 'log'; enabled?: boolean; match: FirewallMatch };
export type FirewallRule = FirewallRuleInput & { id: string; enabled: boolean };
export type FirewallRateLimitInput = { id?: string; name: string; enabled?: boolean; paths: string[]; methods?: string[]; limit: number; windowSeconds: number; algorithm?: 'fixed' | 'sliding' };
export type FirewallRateLimit = FirewallRateLimitInput & { id: string; enabled: boolean; algorithm: 'fixed' | 'sliding' };
export type FirewallBot = { mode: 'off' | 'challenge' | 'deny'; threshold: number; allowVerified: boolean; exposeScore: boolean };

/** N1: `GET /v1/apps/projects/{id}/firewall`. */
export type FirewallSettings = {
  projectId: string;
  available: boolean;
  enforced: boolean;
  challengeAvailable: boolean;
  logAvailable?: boolean;
  plan: 'hobby' | 'pro';
  limits: { rules: number; rateLimits: number; valuesPerRule: number; totalValues: number; botManagement: boolean; staticEgress: boolean };
  generation: number;
  rules: FirewallRule[];
  rateLimits: FirewallRateLimit[];
  bot: FirewallBot;
  clamped: boolean;
  coverage: 'edge_frontends';
  notice: string | null;
  docsUrl: string;
  updatedAt: string | null;
};

/** N1: `GET /v1/apps/projects/{id}/firewall/matches` — sampled per-rule match counts. */
export type FirewallMatches = { projectId: string; from: string; to: string; rules: { ruleId: string; name: string; action: string; matches: number }[]; sampled: true };

/** A10: `POST /v1/apps/projects/{id}/compose/preview` and `/compose/apply` (one body for both). */
export type ComposeImportInput = {
  compose: string;
  environmentId?: string | null;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  substitutions?: Record<string, 'managed' | 'container'>;
  source?: { type: 'upload'; uploadId: string } | { type: 'git'; url: string; ref?: string | null } | null;
  deploy?: boolean;
};
export type ComposeNote = { service: string | null; key: string | null; message: string; fix?: string };
export type ComposePreview = {
  projectId: string;
  environment: { id: string; name: string };
  planHash: string;
  canApply: boolean;
  services: {
    name: string;
    from: string;
    kind: 'web' | 'worker';
    image: string | null;
    build: { context: string; dockerfile: string | null; deployable: boolean } | null;
    size: string;
    replicas: number;
    port: number | null;
    startCommand: string | null;
    healthcheckPath: string | null;
    dependsOn: string[];
    order: number;
    /** Secrets have value null: they are never shown. */
    variables: { key: string; secret: boolean; reference: boolean; value: string | null }[];
    volume: { name: string; from: string; mountPath: string; sizeGb: number } | null;
  }[];
  databases: { name: string; from: string; version: number; size: string; storageGb: number; extensions: string[] }[];
  valkeys: { name: string; from: string; size: string; storageGb: number }[];
  offers: { service: string; image: string; kind: 'postgres' | 'valkey'; chosen: 'managed' | 'container'; available: boolean }[];
  moves: string[];
  changed: ComposeNote[];
  refused: ComposeNote[];
  missingValues: string[];
  blocking: ComposeNote[];
  dataImport: { database: string; from: string; automated: boolean; steps: string[] }[];
};
export type ComposeApplied = {
  projectId: string;
  environmentId: string;
  replayed: boolean;
  created: { kind: 'service' | 'database' | 'valkey' | 'volume'; name: string; id: string; created: boolean }[];
  deployments: { service: string; status: 'queued' | 'building' | 'replayed' | 'not_deployed' | 'failed_to_queue'; deploymentId: string | null; operationId: string | null; reason: string | null }[];
  dataImport: ComposePreview['dataImport'];
  preview: ComposePreview;
};

export type FirewallChange = { rules?: FirewallRuleInput[]; rateLimits?: FirewallRateLimitInput[]; bot?: Partial<FirewallBot>; expectedGeneration?: number };

/** Moving a project from Vercel: `POST /v1/apps/projects/{id}/vercel/preview` and `/vercel/apply` (one body for both). */
export type VercelImportInput = {
  connectionId: string;
  vercelProject: string;
  service?: string | null;
  target?: 'auto' | 'edge' | 'container';
  storage?: Partial<Record<'blob' | 'postgres' | 'valkey', 'create' | 'keep'>>;
  domains?: boolean;
  crons?: boolean;
  github?: boolean;
  secrets?: Record<string, string>;
  skip?: string[];
  deploy?: boolean;
};
export type VercelImportNote = { item: string | null; message: string; fix?: string; docs_url?: string };
export type VercelImportPreview = {
  projectId: string;
  environment: { id: string; name: string };
  source: { id: string; name: string; framework: string | null };
  planHash: string;
  canApply: boolean;
  service: { name: string; kind: 'frontend' | 'web'; target: 'edge' | 'container'; framework: string; port: number | null; size: string };
  /** Secrets have value null: they are never shown. */
  variables: { key: string; secret: boolean; reference: boolean; availableToPreviews: boolean; value: string | null }[];
  database: { name: string; version: number; size: string; storageGb: number; from: string } | null;
  valkey: { name: string; size: string; storageGb: number; from: string } | null;
  blobStore: { name: string; access: string; from: string } | null;
  storage: { kind: 'blob' | 'postgres' | 'valkey'; label: string; host: string; choice: 'create' | 'keep'; available: boolean }[];
  copies: { kind: 'blob' | 'postgres' | 'valkey'; label: string; host: string; unit: string; target: string }[];
  domains: { hostname: string }[];
  crons: { name: string; path: string; schedule: string }[];
  github: { repository: string; branch: string | null; appInstalled: boolean | null } | null;
  moves: string[];
  changed: VercelImportNote[];
  refused: VercelImportNote[];
  missingValues: string[];
  blocking: VercelImportNote[];
  nextSteps: string[];
};
export type DataCopy = {
  id: string;
  kind: 'blob' | 'postgres' | 'valkey';
  label: string;
  sourceHost: string;
  targetId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  done: number;
  total: number | null;
  skipped: number;
  unit: string;
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};
export type VercelImportApplied = {
  importId: string;
  projectId: string;
  environmentId: string;
  replayed: boolean;
  created: { kind: 'service' | 'database' | 'valkey' | 'variables' | 'domain'; name: string; id: string | null; created: boolean }[];
  steps: { item: string; status: 'done' | 'skipped' | 'action_required' | 'failed'; message: string; fix?: string; docs_url?: string }[];
  copies: DataCopy[];
  github: { status: 'linked' | 'app_required' | 'dashboard_required' | 'not_linked' | 'failed'; message: string; fix?: string };
  preview: VercelImportPreview;
};
export type ProjectImport = {
  id: string;
  projectId: string;
  environmentId: string;
  source: 'vercel';
  sourceProject: { id: string; name: string };
  planHash: string;
  summary: Record<string, unknown>;
  githubStatus: VercelImportApplied['github']['status'];
  createdAt: string;
  copies: DataCopy[];
};
export type VercelProjectSummary = { id: string; name: string; framework: string | null; updatedAt: number | null };

/** E4: one web service's reachability (public, or private to its project). */
export type PrivateService = {
  serviceId: string;
  name: string;
  environmentId: string;
  visibility: 'public' | 'project';
  privateUrl: string | null;
  bindings: { url: string; token: string };
  routed: boolean;
  eligible: boolean;
  reason: string | null;
};

/** E4: `GET /v1/apps/projects/{id}/private-networking`. */
export type PrivateNetworking = {
  projectId: string;
  available: boolean;
  transport: 'tunnel' | 'workers_vpc';
  tunnel: boolean;
  privateDomain: string;
  issuer: string;
  services: PrivateService[];
  keys: { kid: string; state: 'next' | 'active' | 'retiring' | 'retired'; activateAfter: string | null; retireAfter: string | null; activatedAt: string | null; retiredAt: string | null; createdAt: string }[];
  tokens: { current: number; nextExpiry: string | null };
  databases: DatabaseEdgeAccess[];
  notice: string;
  docsUrl: string;
};

/** E4: a database's edge access (Hyperdrive over the cluster's Tunnel). */
export type DatabaseEdgeAccess = {
  databaseId: string;
  name: string;
  status: 'off' | 'pending' | 'active' | 'removing' | 'removed' | 'failed';
  hostname: string | null;
  reference: string;
  tokenExpiresAt: string | null;
  rotatedAt: string | null;
  lastError: string | null;
};

export type ServiceVisibilityResult = { service: PrivateService; changed: boolean; frontendsUpdated: number; warning: string | null };
export type PrivateKeyRotation = { kid: string; state: 'next' | 'active'; activateAfter: string | null; retired: string[]; frontendsUpdated: number; warning: string | null };

/** N1: `GET /v1/apps/projects/{id}/egress`. */
export type StaticEgress = {
  projectId: string;
  available: boolean;
  planAllows: boolean;
  status: 'off' | 'pending' | 'active' | 'removing' | 'failed';
  enabled: boolean;
  ip: string | null;
  reservedIp: string | null;
  reservedUntil: string | null;
  lastError: string | null;
  activeAt: string | null;
  monthlyPriceCents: number;
  coverage: 'containers';
  notice: string;
  docsUrl: string;
};

/** X1: `GET /v1/apps/sandboxes/{id}` — an isolated, short-lived machine for running untrusted code. */
export type Sandbox = {
  id: string;
  projectId: string;
  name: string | null;
  image: string;
  size: 'small' | 'medium' | 'large';
  resources: { cpuMillis: number; memoryMiB: number; diskMiB: number; maxPids: number };
  internet: boolean;
  ports: number[];
  portsReady: boolean;
  status: 'queued' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  stopReason: string | null;
  failure: string | null;
  lifetimeSeconds: number;
  idleTimeoutSeconds: number;
  restoredFrom: string | null;
  createdAt: string;
  runningAt: string | null;
  expiresAt: string;
  endedAt: string | null;
  dataApiUrl: string;
};
export type SandboxInput = { name?: string; image?: string; size?: 'small' | 'medium' | 'large'; lifetimeSeconds?: number; idleTimeoutSeconds?: number; internet?: boolean; ports?: number[]; snapshotId?: string };
export type SandboxCommand = { id: string; status: string; exitCode: number | null; timedOut: boolean; error: string | null; outputTruncated: boolean };
export type SandboxExecInput = { cmd: string | string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutSeconds?: number };
export type SandboxExecResult = { command: SandboxCommand; done: boolean; stdout: string; stderr: string; stdoutBase64: string; stderrBase64: string };
export type SandboxFile = { path: string; contentBase64: string; sizeBytes: number };
export type SandboxFileEntry = { name: string; path: string; type: 'file' | 'directory' | 'symlink' | 'other'; sizeBytes: number; modifiedAt: string | null };
export type SandboxPortUrl = { port: number; url: string; host: string; expiresAt: string; ready: boolean };
export type SandboxSnapshot = { id: string; projectId: string; sourceSandboxId: string | null; name: string | null; image: string; status: 'pending' | 'ready' | 'failed' | 'deleted'; sizeBytes: number | null; createdAt: string; expiresAt: string };

/** E3: `GET /v1/apps/projects/{id}/edge-settings` — the values in force. */
export type EdgeSettings = { previewTtlDays: number; oldAddressesOpen: boolean };

/**
 * D1: a registered domain as an agent sees it (`GET /v1/apps/domains`). Registry ownership through a
 * registrar — not a hostname bound to a service. Never a contact detail, never a transfer code.
 */
export type DomainRegistration = {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  registeredOn: string | null;
  expiresOn: string | null;
  autoRenew: boolean;
  locked: boolean;
  privacy: boolean;
  nameservers: string[];
  registrar: { key: string; name: string } | null;
  managedBy: 'create' | 'whmcs';
  hostingServiceId: string | null;
  transferOut: { state: string; at: string | null } | null;
  openInvoice: { id: string; number: string | null; dueOn: string; amountDue: number; currency: string } | null;
};
export type DomainList = { accountId: string; registrations: DomainRegistration[] };
/** E3: `PATCH …/edge-settings` — previewTtlDays 1–90, or null for the deployment default. */
export type EdgeSettingsChange = { previewTtlDays?: number | null; oldAddressesOpen?: boolean };

/** A7 alerting: a rule's parameters (which ones a signal reads is in the docs). */
export type AlertParams = { threshold?: number; windowMinutes?: number; minRequests?: number; serviceId?: string; forEvaluations?: number; resolveAfterEvaluations?: number; projectOnly?: boolean };
export type AlertQuietHours = { start: string; end: string; timeZone: string };
export type AlertRule = {
  id: string;
  name: string;
  signal: string;
  params: AlertParams;
  effective: AlertParams;
  channelIds: string[];
  enabled: boolean;
  quietHours: AlertQuietHours | null;
  renotifyMinutes: number | null;
  isDefault: boolean;
  evaluatedAt: string | null;
  evaluationError: string | null;
  suppressed: number;
};
export type AlertChannel = {
  id: string;
  name: string;
  kind: 'email' | 'webhook' | 'slack';
  target: { host?: string; path?: string; flavor?: 'slack' | 'discord'; roles?: string[] };
  url: string | null;
  status: 'active' | 'failing' | 'disabled';
  statusReason: string | null;
  health: { consecutiveFailures: number; lastDeliveredAt: string | null; lastError: string | null; lastErrorAt: string | null };
  isDefault: boolean;
};
export type AlertIncident = { id: string; ruleId: string; signal: string; subject: string; subjectLabel: string; state: 'pending' | 'firing' | 'resolved'; value: number | null; summary: string; startedAt: string; firedAt: string | null; resolvedAt: string | null };
export type AlertNotification = { id: string; incidentId: string | null; channelId: string; event: string; status: string; title: string; lastError: string | null; createdAt: string };
/** A7: `GET /v1/apps/projects/{id}/alerts`. */
export type AlertsOverview = { projectId: string; rules: AlertRule[]; channels: AlertChannel[]; incidents: AlertIncident[]; notifications: AlertNotification[] };
export type AlertRuleInput = { signal: string; name?: string; params?: AlertParams; channelIds?: string[]; enabled?: boolean; quietHours?: AlertQuietHours | null; renotifyMinutes?: number | null };
export type AlertRuleChange = Omit<Partial<AlertRuleInput>, 'signal'>;
export type AlertChannelInput = { kind: 'email'; name: string; roles?: string[] } | { kind: 'webhook'; name: string; url: string } | { kind: 'slack'; name: string; url: string };

/** A11: `GET /v1/apps/services/{id}/scaling`. */
/** A11 "wake now": `awake` — it was not asleep; `waking` — the cluster has been asked to start it. */
export type ServiceWake = { serviceId: string; state: 'awake' | 'waking'; requestedAt: string | null };

/** A12: whether Create is reviewing a project (a hold and its notice, in generic words) and how to appeal. */
export type ReviewNotice = {
  projectId: string;
  hold: 'throttled' | 'stopped' | 'frozen' | null;
  since: string | null;
  notice: { title: string; body: string } | null;
  appeal: { allowed: boolean; lastAppealAt: string | null; copy: string };
};

export type ServiceScaling = {
  serviceId: string;
  name: string;
  size: string;
  /** The image the service runs (null until its first build). */
  image: string | null;
  kind: string;
  available: boolean;
  plan: 'hobby' | 'pro';
  replicas: number;
  maxReplicas: number | null;
  targetCpuPercent: number;
  sleepAfterSeconds: number | null;
  effective: { replicas: number; minReplicas: number; maxReplicas: number; targetCpuPercent: number; sleepAfterSeconds: number };
  entitlements: { sizes: string[]; maxReplicas: number; autoscale: boolean; sleep: 'mandatory' | 'optional'; maxSleepAfterSeconds: number };
  state: { sleeping: boolean; sleepingSince: string | null; lastWokeAt: string | null; lastColdStartMs: number | null };
  pendingDeploy: boolean;
};
export type ScalingChange = { replicas?: number; maxReplicas?: number | null; targetCpuPercent?: number; sleepAfterSeconds?: number | null; redeploy?: boolean };

/** E6: `GET /v1/apps/projects/{id}/analytics`. */
export type AnalyticsReport = {
  projectId: string;
  enabled: boolean;
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  retentionDays: number;
  clamped: boolean;
  totals: { pageviews: number; visitors: number };
  series: { bucket: string; pageviews: number; visitors: number }[];
  topPages: AnalyticsTopRow[];
  referrers: AnalyticsTopRow[];
  countries: AnalyticsTopRow[];
  devices: AnalyticsTopRow[];
  utmSources: AnalyticsTopRow[];
  usage: AnalyticsSettings['usage'];
};

export type WebVitalValue = { p75: number; samples: number; rating: 'good' | 'needs_improvement' | 'poor' };
export type WebVitalSet = Partial<Record<'LCP' | 'INP' | 'CLS' | 'TTFB' | 'FCP', WebVitalValue>>;

/** E6: `GET /v1/apps/projects/{id}/speed-insights`. */
export type SpeedInsightsReport = {
  projectId: string;
  enabled: boolean;
  from: string;
  to: string;
  retentionDays: number;
  clamped: boolean;
  overall: WebVitalSet;
  routes: { route: string; metrics: WebVitalSet }[];
  deployments: { deploymentId: string; metrics: WebVitalSet }[];
  devices: { device: string; metrics: WebVitalSet }[];
};

export type AnalyticsRangeQuery = { from?: string; to?: string; granularity?: 'hour' | 'day' };
/** S1: a Create Blob store (`/v1/apps/blob-stores/{id}`). */
export type BlobStore = {
  id: string;
  accountId: string;
  projectId: string;
  name: string;
  access: 'public' | 'private';
  inlineImages: boolean;
  variableName: string;
  status: 'active' | 'deleting' | 'deleted';
  suspended: boolean;
  baseUrl: string;
  bytesUsed: number;
  objectCount: number;
  plan: 'hobby' | 'pro';
  quota: { storageBytes: number; maxObjectBytes: number; monthlyOperations: number; monthlyEgressBytes: number; monthlyEdgeReads: number; maxObjects: number };
  usage: { month: string; operations: number; edgeReads: number; egressBytes: number; ingressBytes: number };
  createdAt: string;
};
export type BlobItem = { url: string; downloadUrl: string; pathname: string; size: number; contentType: string; uploadedAt: string; etag: string; cacheControlMaxAge: number };
export type BlobList = { blobs: BlobItem[]; folders?: string[]; cursor: string | null; hasMore: boolean };
export type BlobUploadUrl = { uploadUrl: string; method: 'PUT'; pathname: string; url: string; expiresAt: string; maxBytes: number; allowedContentTypes: string[] };
export type BlobStoreInput = { name: string; access: 'public' | 'private'; inlineImages?: boolean; variableName?: string };
export type BlobUploadUrlInput = { pathname: string; maxBytes?: number; allowedContentTypes?: string[]; addRandomSuffix?: boolean; allowOverwrite?: boolean; cacheControlMaxAge?: number };
/** S1 multipart (the CLI's large files): an upload in progress, its signed part URLs. */
export type BlobMultipartUpload = { uploadId: string; key: string; pathname: string; contentType: string; reservedBytes: number; declaredSize: number | null; partSize: number; limits: { minPartBytes: number; maxPartBytes: number; maxParts: number }; status: string; expiresAt: string; createdAt: string };
export type BlobMultipartInput = { pathname: string; size?: number; contentType?: string; addRandomSuffix?: boolean; allowOverwrite?: boolean; cacheControlMaxAge?: number };
export type BlobPartUrls = { uploadId: string; key: string; expiresAt: string; parts: { partNumber: number; size: number; method: 'PUT'; url: string }[]; completeUrl: string | null };

/** X3: a queue or workflow (`/v1/apps/queues/{id}`, `/v1/apps/workflows/{id}`). Never carries a secret. */
export type AppsQueue = {
  id: string;
  kind: 'queue' | 'workflow';
  projectId: string;
  environmentId: string;
  name: string;
  delivery: 'push' | 'pull';
  target: { serviceId: string; path: string } | null;
  settings: { visibilityTimeoutSeconds: number; maxAttempts: number; retryDelaySeconds: number; retentionSeconds: number; maxConcurrency: number };
  paused: boolean;
  url: string;
  references: { url: string; token: string; signingSecret: string };
  tokenHint: string | null;
  stats: Record<string, number>;
  storedMessages: number;
  lastError: string | null;
  plan: 'hobby' | 'pro';
  limits: { maxPayloadBytes: number; messagesPerDay: number; deliveriesPerDay: number; maxConcurrency: number; maxRetentionSeconds: number };
  usageToday: { day: string; messages: number; deliveries: number };
  schedules: { id: string; cron: string; nextRunAt: string; lastRunAt: string | null; lastError: string | null }[];
  createdAt: string;
};
export type AppsQueueInput = {
  name: string;
  environmentId?: string;
  delivery?: 'push' | 'pull';
  target?: { serviceId: string; path: string } | null;
  visibilityTimeoutSeconds?: number;
  maxAttempts?: number;
  retryDelaySeconds?: number;
  retentionSeconds?: number;
  maxConcurrency?: number;
};
export type AppsQueueMessageInput = { body: unknown; contentType?: 'json' | 'text'; delaySeconds?: number; dedupeKey?: string };
export type AppsDeadLetter = { id: string; attempts: number; size: number; contentType: 'json' | 'text'; lastError: string | null; enqueuedAt: string; deadAt: string | null; expiresAt: string };
export type AppsWorkflowRun = {
  id: string;
  workflowId: string;
  status: 'queued' | 'running' | 'sleeping' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  stepCount: number;
  invocations: number;
  wakeAt: string | null;
  waitingFor: { step: string; event: string | null } | null;
  failureCode: string | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  steps?: { key: string; kind: 'run' | 'sleep' | 'wait'; seq: number; attempts: number; size: number; completedAt: string }[];
};

/** X2: a project's AI Gateway (`/v1/apps/projects/{id}/ai-gateway`). Never carries a token or a provider key. */
type AiProviderId = 'openai' | 'anthropic' | 'google' | 'mistral' | 'xai' | 'groq' | 'together' | 'fireworks' | 'deepinfra' | 'cerebras' | 'openrouter';
export type AiModelPolicyInfo = { allowProviders: AiProviderId[] | null; denyProviders: AiProviderId[]; allowOriginCountries: string[] | null; denyOriginCountries: string[]; hostingRegions: ('US' | 'EU' | 'global')[]; openWeightsOnly: boolean; noAggregators: boolean };
export type AiGatewayInfo = {
  projectId: string;
  /** The stored model policy no longer validated and is enforced restrictively until someone re-saves it. */
  policyNeedsAttention?: boolean;
  configured: boolean;
  enabled: boolean;
  plan: 'hobby' | 'pro';
  url: string;
  references: { url: string; token: string };
  settings: { allowedModels: string[] | null; monthlyLimitMicrousd: number; logBodies: boolean; bodyRetentionDays: number; cacheEnabled: boolean; cacheTtlSeconds: number; modelPolicy?: AiModelPolicyInfo; defaultModel?: string | null };
  markupBps: number;
  models: {
    id: string;
    label: string;
    provider: AiProviderId;
    allowed: boolean;
    blockedBy?: string | null;
    keySource: 'create' | 'byok' | null;
    createKeys?: boolean;
    listPrice: { input: number; output: number };
    billedPrice: { input: number; output: number };
    maxOutputTokens: number;
    costIndex?: number;
    tier?: 'frontier' | 'strong' | 'fast' | 'budget';
    speed?: 'fastest' | 'fast' | 'standard';
    tools?: boolean;
    reasoning?: 'none' | 'included' | 'extra';
    openWeights?: boolean;
    origin?: { developer: string; country: string };
    contextTokens?: number;
  }[];
  aliases?: { id: string; description: string; resolvesTo: string | null }[];
  tokens: { id: string; name: string; kind: 'reference' | 'api'; hint: string; models: string[] | null; monthlyLimitMicrousd?: number | null; createdAt: string; lastUsedAt: string | null; graceEndsAt: string | null }[];
  providerKeys: { provider: AiProviderId; hint: string; createdAt: string }[];
  usage: {
    month: string;
    billedMicrousd: number;
    reservedMicrousd: number;
    limitMicrousd: number;
    byModel: { model: string; keySource: 'create' | 'byok'; requests: number; inputTokens: number; outputTokens: number; billedMicrousd: number; costMicrousd?: number }[];
    savings?: { model: string; cheaperModel: string; billedMicrousd: number; wouldBillMicrousd: number; estimate: true }[];
  };
};
export type AiGatewaySettingsInput = { enabled?: boolean; allowedModels?: string[] | null; monthlyLimitMicrousd?: number; logBodies?: boolean; bodyRetentionDays?: number; cacheEnabled?: boolean; cacheTtlSeconds?: number; modelPolicy?: Partial<AiModelPolicyInfo> | null; defaultModel?: string | null };
/** 2026-10-04: `endpoint` (embeddings estimate inputs, not output), `images` (per-image bound), cache reads/writes for the typical figure. */
export type AiEstimateInput = {
  model?: string;
  endpoint?: 'chat' | 'responses' | 'messages' | 'embeddings';
  inputBytes?: number;
  inputTokens?: number;
  maxTokens?: number;
  messages?: number;
  tools?: boolean;
  images?: number;
  embeddingInputs?: number;
  expectedOutputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTtl?: '5m' | '1h';
};
export type AiEstimateInfo = { model: string; keySource: 'create' | 'byok' | null; worstCaseMicrousd: number; typicalMicrousd: number; inputTokensAssumed: number; outputTokensAssumed: number; costIndex: number; cheaper: { model: string; typicalMicrousd: number; costIndex: number }[]; estimate: true; note?: string };
export type AiGatewayRequestInfo = {
  id: string;
  model: string;
  provider: AiProviderId;
  keySource: 'create' | 'byok';
  stream: boolean;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  billedMicrousd: number;
  cacheHit: boolean;
  latencyMs: number | null;
  startedAt: string;
};

export type UploadTicket = { uploadId: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string; maxBytes: number };

export type LogLine = {
  at: string;
  stream: 'build' | 'runtime';
  text: string;
  /** A7 runtime lines: level when known, where it came from (container, edge, edge-request), the deployment. */
  level?: 'debug' | 'info' | 'warn' | 'error' | null;
  source?: string;
  deploymentId?: string | null;
  fields?: Record<string, string>;
};

/** A7: what a runtime log read may filter on (ISO 8601 times; `q` is literal text). */
export type LogQueryInput = { type: 'build' | 'runtime'; deploymentId: string | null; lines: number; from?: string | null; to?: string | null; q?: string | null; level?: 'debug' | 'info' | 'warn' | 'error' | null };

export const METRIC_NAMES = ['cpu', 'memory', 'requests', 'errors', 'latency'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export type MetricSeries = { metric: MetricName; unit: string; from: string; to: string; stepSeconds: number; source: 'container' | 'edge'; series: { name: string; points: [number, number][] }[] };

export type ServiceSpec = { name: string; kind: 'web' | 'worker'; port?: number | null; size: string; replicas: number };

export type VariableChange = { set: { key: string; value: string; secret?: boolean; buildTime?: boolean; serviceId?: string | null }[]; remove: { key: string; serviceId?: string | null }[] };

/** A4: a variable as the API lists it — a secret's value is always null (write-only). */
export type Variable = { id: string; key: string; serviceId: string | null; secret: boolean; buildTime: boolean; value: string | null; references: string[] };

/** A9: a project's connected GitHub repository. */
export type GitHubLink = {
  id: string;
  projectId: string;
  repository: string;
  productionBranch: string;
  service: string;
  target: 'auto' | 'container' | 'edge';
  framework: string | null;
  previewsEnabled: boolean;
};

export type GitHubConnectInput = { repository: string; branch?: string | null; service?: string; target?: TargetChoice; framework?: string | null; previews?: boolean; deploy?: boolean };

/** A9: a pull request's or branch's preview environment. */
export type Preview = {
  id: string;
  kind: 'pull_request' | 'branch';
  pullRequest: number | null;
  /** The preview environment (`create status` labels its services with the branch). */
  environmentId?: string;
  branch: string;
  headSha: string;
  fork: boolean;
  status: 'awaiting_approval' | 'building' | 'ready' | 'failed' | 'closed';
  url: string | null;
  deploymentId: string | null;
  lastActivityAt: string;
  closeReason: string | null;
};

/** A6: a managed Postgres database as the API shows it — never a password or a connection string. */
export type Database = {
  id: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  name: string;
  engine: 'postgres';
  version: number;
  size: string;
  instances: number;
  ha: boolean;
  storageGb: number;
  retentionDays: number;
  pitr: boolean;
  extensions: string[];
  publicAccess: { enabled: boolean; cidrs: string[]; host: string | null };
  status: string;
  observed: { readyInstances: number | null; phase: string | null };
  backups: { status?: 'available' | 'unavailable'; reason?: string | null; lastBackupAt: string | null; firstRecoverabilityPoint: string | null };
  credentials: { username: string | null };
  references: Record<string, string>;
  deleteAfter: string | null;
  lastError: string | null;
};
export type DatabaseSpec = { name: string; version?: number; size?: string; storageGb?: number; ha?: boolean; extensions?: string[]; environmentId?: string };
export type DatabasePatch = { size?: string; storageGb?: number; ha?: boolean; extensions?: string[]; retentionDays?: number };
export type DatabaseBackup = { id: string; name: string; kind: string; status: string; backupId: string | null; startedAt: string | null; stoppedAt: string | null };
export type DatabaseConnectSession = { id: string; username: string; password: string; role: string; database: string; port: number; host: string | null; clientCidr: string; expiresAt: string };

export interface AppsBackend {
  whoami(): Promise<Whoami>;
  listProjects(): Promise<ProjectListItem[]>;
  getProject(projectId: string): Promise<Project>;
  createProject(input: { name: string; region: string; idempotencyKey: string; /** No compute: prebuilt edge bundles only (fixed at creation). */ edgeOnly?: boolean }): Promise<Project>;
  listDeployments(serviceId: string): Promise<Deployment[]>;
  getDeployment(deploymentId: string): Promise<Deployment>;
  createService(projectId: string, spec: ServiceSpec & { image: string }, idempotencyKey: string): Promise<Service>;
  updateService(serviceId: string, patch: { size?: string; replicas?: number; port?: number | null; image?: string }): Promise<Service>;
  deployImage(serviceId: string, image: string, idempotencyKey: string): Promise<DeployAccepted>;
  rollback(deploymentId: string, idempotencyKey: string): Promise<DeployAccepted>;
  setVariables(environmentId: string, change: VariableChange): Promise<{ key: string; secret: boolean; serviceId: string | null }[]>;
  deleteProject(projectId: string, confirm: string): Promise<{ project: Project }>;
  logs(serviceId: string, input: LogQueryInput): Promise<LogLine[]>;
  /** A7: a service's metric over time. Optional: a backend without it answers not_available_yet. */
  metrics?(serviceId: string, input: { metric: MetricName; from?: string | null; to?: string | null; step?: number | null }): Promise<MetricSeries>;
  /** A3 seam: a pre-signed slot a client with a shell PUTs a tarball to. */
  createUpload(projectId: string, sizeBytes: number, sha256: string): Promise<UploadTicket>;
  /** A3 seam: bytes already in hand (the tool call carried them, or the CLI read a folder) become an upload. */
  storeUpload(projectId: string, tarball: Uint8Array, sha256: string): Promise<{ uploadId: string }>;
  /**
   * A3 seam: build and deploy an upload into the named service (created when missing). E2: the
   * control plane's framework detector decides edge or container unless `options.target` says.
   */
  deployUpload(projectId: string, service: ServiceSpec, uploadId: string, idempotencyKey: string, options?: SourceDeployOptions): Promise<DeployAccepted>;
  /** A3 seam: build and deploy a public Git repository into the named service (created when missing). E2: `target: "edge"` needs `framework`. */
  deployGit(projectId: string, service: ServiceSpec, repository: string, ref: string | null, idempotencyKey: string, options?: SourceDeployOptions): Promise<DeployAccepted>;
  /** E1: deploy a pre-built edge bundle (a .tar.gz with create-edge.json) to the frontend named `service` (created when missing). */
  deployEdgeBundle(projectId: string, service: string, tarball: Uint8Array, idempotencyKey: string, options?: { preview?: { branch: string | null } | null }): Promise<EdgeDeployAccepted>;
  /** E1: claim a custom hostname for an edge frontend; the answer carries the TXT and CNAME records to create. */
  attachHostname(serviceId: string, hostname: string): Promise<EdgeHostname>;
  /** E1: check the TXT ownership record and advance the claim (set up at Cloudflare, route once active). */
  verifyHostname(hostnameId: string): Promise<EdgeHostname>;
  /** A4 (CLI): an environment's variables, secrets without values. Optional: the remote MCP does not need it. */
  listVariables?(environmentId: string): Promise<Variable[]>;
  /** A4 (CLI): a service's hostnames, default and custom. */
  listHostnames?(serviceId: string): Promise<EdgeHostname[]>;
  /** A4 (CLI): detach a custom hostname. */
  removeHostname?(hostnameId: string): Promise<{ removed: boolean }>;
  /** Apex gateway: a service's bare domains. */
  listApexDomains?(serviceId: string): Promise<ApexDomain[]>;
  /** Apex gateway: add a bare domain redirecting to one of the service's custom hostnames. */
  addApexDomain?(serviceId: string, input: ApexDomainInput): Promise<ApexDomain>;
  /** Apex gateway: check the TXT ownership record and the A/AAAA records. */
  verifyApexDomain?(apexId: string): Promise<ApexDomain>;
  /** Apex gateway: remove a bare domain. */
  removeApexDomain?(apexId: string): Promise<{ removed: boolean }>;
  /** E5: the project's image settings (allowed remote image domains, quota, usage this month). */
  getImageSettings?(projectId: string): Promise<ImageSettings>;
  /** E5: replace the project's allowed remote image domains; effective at the edge at once. */
  setImageDomains?(projectId: string, domains: string[]): Promise<ImageSettings>;
  /** E6: the project's Web Analytics opt-in, quota and usage. */
  getAnalyticsSettings?(projectId: string): Promise<AnalyticsSettings>;
  /** E6: turn Web Analytics + Speed Insights on or off; effective at the edge at once. */
  setAnalytics?(projectId: string, enabled: boolean): Promise<AnalyticsSettings>;
  /** E6: traffic over a range. */
  getAnalytics?(projectId: string, query: AnalyticsRangeQuery): Promise<AnalyticsReport>;
  /** E6: Core Web Vitals (p75) over a range. */
  getSpeedInsights?(projectId: string, query: AnalyticsRangeQuery): Promise<SpeedInsightsReport>;
  /** E7: how the project's previews, deployment addresses and production are protected. */
  getProtection?(projectId: string): Promise<ProtectionSettings>;
  /** E7: change the protection modes (any change signs everyone out of the protected addresses). */
  setProtection?(projectId: string, change: ProtectionChange): Promise<ProtectionSettings>;
  /** E7: set or replace (a string) or remove (null) the preview password. */
  setProtectionPassword?(projectId: string, password: string | null): Promise<ProtectionSettings>;
  /** E7: sign everyone out of the project's protected addresses. */
  revokeProtectionSessions?(projectId: string): Promise<ProtectionSettings>;
  /** E7: the project's share links (no tokens). */
  listShareLinks?(projectId: string): Promise<ShareLink[]>;
  /** E7: create a share link; the token is returned once. */
  createShareLink?(projectId: string, input: ShareLinkInput): Promise<ShareLinkCreated>;
  /** E7: revoke a share link (its visitors are signed out). */
  revokeShareLink?(projectId: string, linkId: string): Promise<ShareLink>;
  /** E7b: the project's preview comment threads (open by default). */
  listComments?(projectId: string, query: PreviewCommentQuery): Promise<PreviewCommentThread[]>;
  /** E7b: reply to a comment thread (plain text). */
  replyComment?(projectId: string, threadId: string, body: string): Promise<PreviewCommentThread>;
  /** E7b: resolve or reopen a comment thread. */
  setCommentStatus?(projectId: string, threadId: string, status: 'open' | 'resolved'): Promise<PreviewCommentThread>;
  /** A10: preview a Docker Compose import (nothing is created). */
  previewCompose?(projectId: string, input: ComposeImportInput): Promise<ComposePreview>;
  /** A10: apply the previewed plan (all or nothing), then queue deploys in depends_on order. */
  applyCompose?(projectId: string, input: ComposeImportInput & { planHash: string }, idempotencyKey: string): Promise<ComposeApplied>;
  /** Moving from Vercel: the projects a connection (made in the dashboard) can read. */
  listVercelProjects?(connectionId: string): Promise<VercelProjectSummary[]>;
  /** Moving from Vercel: preview (reads Vercel; nothing is created). */
  previewVercelImport?(projectId: string, input: VercelImportInput): Promise<VercelImportPreview>;
  /** Moving from Vercel: apply the previewed plan (all or nothing), then copy data and delete the token. */
  applyVercelImport?(projectId: string, input: VercelImportInput & { planHash: string }, idempotencyKey: string): Promise<VercelImportApplied>;
  /** An import with its data copies' progress. */
  getImportStatus?(importId: string): Promise<ProjectImport>;
  /** N1: the project's edge firewall (rules, rate limits, bot policy). */
  getFirewall?(projectId: string): Promise<FirewallSettings>;
  /** N1: how many requests each rule matched in the last `hours` (sampled). */
  getFirewallMatches?(projectId: string, hours?: number): Promise<FirewallMatches>;
  /** N1: replace the rules, rate limits and/or bot policy (a part left out stays). */
  setFirewall?(projectId: string, change: FirewallChange): Promise<FirewallSettings>;
  /** N1: add one rule (at the end or at `position`). */
  addFirewallRule?(projectId: string, rule: FirewallRuleInput, position?: number): Promise<{ rule: FirewallRule; firewall: FirewallSettings }>;
  /** N1: delete one rule or rate limit by id. */
  deleteFirewallRule?(projectId: string, ruleId: string): Promise<FirewallSettings>;
  /** A11: a service's autoscaling and sleep-on-idle, its plan limits and whether it is asleep. */
  getScaling?(serviceId: string): Promise<ServiceScaling>;
  /** A11 ("wake now"): ask the cluster to wake a sleeping web service without sending it a request. */
  wakeService?(serviceId: string): Promise<ServiceWake>;
  /** A12: the project's review notice (a hold while Create reviews it) and whether an appeal is open to a person. */
  getReviewNotice?(projectId: string): Promise<ReviewNotice>;
  /** A11: change the replica floor, the autoscaler and sleep-on-idle (redeploy: roll it out now). */
  setScaling?(serviceId: string, change: ScalingChange): Promise<{ scaling: ServiceScaling; deployment: DeployAccepted | null }>;
  /** E4: the project's private networking (private services, keys, databases' edge access). */
  getPrivateNetworking?(projectId: string): Promise<PrivateNetworking>;
  /** E4: make a web service private to its project, or public again. */
  setServiceVisibility?(serviceId: string, visibility: 'public' | 'project'): Promise<ServiceVisibilityResult>;
  /** E4: rotate the project's backend-token signing key (emergency: every token stops working now). */
  rotatePrivateKeys?(projectId: string, emergency: boolean): Promise<PrivateKeyRotation>;
  /** E4 (CLI and dashboard; not an MCP tool): open a database to the edge through Hyperdrive, close it, or rotate its Access token. */
  setDatabaseEdgeAccess?(databaseId: string, action: 'enable' | 'disable' | 'rotate'): Promise<{ database: DatabaseEdgeAccess; changed: boolean }>;
  /** N1: the project's static egress IP. */
  getEgress?(projectId: string): Promise<StaticEgress>;
  /** N1: turn the static egress IP on or off. */
  setEgress?(projectId: string, enabled: boolean): Promise<StaticEgress>;
  /** X1: start a sandbox (its token is not passed through tools; the tools act on it by id). */
  createSandbox?(projectId: string, input: SandboxInput): Promise<Sandbox>;
  /** X1: a project's sandboxes (running ones, or all). */
  listSandboxes?(projectId: string, includeEnded: boolean): Promise<Sandbox[]>;
  /** X1: run a command and wait for it. */
  execSandbox?(sandboxId: string, input: SandboxExecInput): Promise<SandboxExecResult>;
  /** X1: write a file under /workspace. */
  writeSandboxFile?(sandboxId: string, path: string, contentBase64: string, mode?: number): Promise<{ command: SandboxCommand }>;
  /** X1: read a file under /workspace. */
  readSandboxFile?(sandboxId: string, path: string): Promise<SandboxFile>;
  /** X1: list a directory under /workspace. */
  listSandboxFiles?(sandboxId: string, path?: string): Promise<{ entries: SandboxFileEntry[]; truncated: boolean }>;
  /** X1: expose a port behind a signed, short-lived URL. */
  exposeSandboxPort?(sandboxId: string, port: number, ttlSeconds?: number): Promise<SandboxPortUrl>;
  /** X1: snapshot /workspace. */
  snapshotSandbox?(sandboxId: string, name?: string): Promise<{ snapshot: SandboxSnapshot; command: SandboxCommand }>;
  /** X1: a project's snapshots. */
  listSandboxSnapshots?(projectId: string): Promise<SandboxSnapshot[]>;
  /** X1: stop a sandbox (its workspace is deleted). */
  stopSandbox?(sandboxId: string): Promise<Sandbox>;
  /** X1: move a running sandbox's end later (never past creation + the plan's maximum lifetime). */
  extendSandbox?(sandboxId: string, addSeconds: number): Promise<Sandbox>;
  /** X1: delete a snapshot. */
  deleteSandboxSnapshot?(snapshotId: string): Promise<void>;
  /** S1: create a blob store; its token is injected into every environment as a sealed variable. */
  createBlobStore?(projectId: string, input: BlobStoreInput): Promise<{ store: BlobStore; environments: number }>;
  /** S1: a project's blob stores. */
  listBlobStores?(projectId: string): Promise<BlobStore[]>;
  /** S1: a page of a store's blobs. */
  listBlobs?(storeId: string, input: { prefix?: string; cursor?: string; limit?: number; mode?: 'expanded' | 'folded' }): Promise<BlobList>;
  /** S1: delete up to 100 blobs. */
  deleteBlobs?(storeId: string, pathnames: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
  /** S1: rotate the store's token (every environment; old signed URLs stop working). */
  rotateBlobToken?(storeId: string): Promise<{ store: BlobStore; environments: number }>;
  /** S1 (CLI `create blob put`): a short-lived URL to PUT one file to. */
  createBlobUploadUrl?(storeId: string, input: BlobUploadUrlInput): Promise<BlobUploadUrl>;
  /** S1 (CLI `create blob put` of a large file): start a multipart upload (quota reserved for its size). */
  createBlobMultipartUpload?(storeId: string, input: BlobMultipartInput): Promise<BlobMultipartUpload>;
  /** S1: signed URLs for parts of an upload (each bound to its number and exact size), and optionally one to complete it. */
  createBlobPartUrls?(storeId: string, uploadId: string, input: { parts: { partNumber: number; size: number }[]; complete?: boolean; expiresIn?: number }): Promise<BlobPartUrls>;
  /** S1: abort a multipart upload (parts discarded, reservation released). */
  abortBlobMultipartUpload?(storeId: string, uploadId: string): Promise<{ uploadId: string; aborted: boolean }>;
  /** X3: create a queue or workflow in one environment. */
  createQueue?(projectId: string, kind: 'queue' | 'workflow', input: AppsQueueInput): Promise<AppsQueue>;
  /** X3: a project's queues or workflows. */
  listQueues?(projectId: string, kind: 'queue' | 'workflow'): Promise<AppsQueue[]>;
  /** X3: send up to 100 messages to a queue. */
  sendQueueMessages?(queueId: string, messages: AppsQueueMessageInput[]): Promise<{ messages: { id: string; deduplicated: boolean }[] }>;
  /** X3: a queue's dead letters (no bodies). */
  listDeadLetters?(queueId: string): Promise<{ deadLetters: AppsDeadLetter[]; cursor: string | null }>;
  /** X3: put dead letters back (all, or the named ids). */
  redriveDeadLetters?(queueId: string, ids: string[] | null): Promise<{ count: number }>;
  /** X3: new token and signing secret (the old ones keep working for a day unless immediate). */
  rotateQueueSecrets?(kind: 'queue' | 'workflow', id: string, immediate: boolean): Promise<{ queue: AppsQueue; graceEndsAt: string | null }>;
  /** X3: delete a queue or workflow and everything it holds. */
  deleteQueue?(kind: 'queue' | 'workflow', id: string, confirm: string): Promise<{ removedMessages: number; removedRuns: number }>;
  /** X3: add a cron schedule (UTC). */
  addQueueSchedule?(kind: 'queue' | 'workflow', id: string, input: { cron: string; payload?: unknown }): Promise<{ id: string; cron: string; nextRunAt: string }>;
  /** X3: start a workflow run. */
  startWorkflowRun?(workflowId: string, input: { input?: unknown; idempotencyKey?: string }): Promise<{ run: AppsWorkflowRun; created: boolean }>;
  /** X3: a workflow's runs, newest first. */
  listWorkflowRuns?(workflowId: string, status?: AppsWorkflowRun['status']): Promise<{ runs: AppsWorkflowRun[]; cursor: string | null }>;
  /** X3: one run with its steps (names only). */
  getWorkflowRun?(workflowId: string, runId: string): Promise<AppsWorkflowRun>;
  /** X3: cancel or retry a run. */
  workflowRunAction?(workflowId: string, runId: string, action: 'cancel' | 'retry'): Promise<AppsWorkflowRun>;
  /** X2: the project's AI Gateway (settings, models, hints, this month's spend). */
  getAiGateway?(projectId: string): Promise<AiGatewayInfo>;
  /** X2: turn the gateway on/off and change its settings. */
  configureAiGateway?(projectId: string, input: AiGatewaySettingsInput): Promise<AiGatewayInfo>;
  /** X2: an API token for use outside Create — returned once. */
  createAiGatewayToken?(projectId: string, input: { name: string; models?: string[]; monthlyLimitMicrousd?: number | null }): Promise<{ token: string; tokenInfo: AiGatewayInfo['tokens'][number] }>;
  /** X2: set or clear an API token's own monthly limit (it only narrows the project's). */
  setAiGatewayTokenLimit?(projectId: string, tokenId: string, monthlyLimitMicrousd: number | null): Promise<{ tokenInfo: AiGatewayInfo['tokens'][number] }>;
  /** X2: revoke an API token at once. */
  revokeAiGatewayToken?(projectId: string, tokenId: string): Promise<{ revoked: boolean }>;
  /** X2: rotate the reference token (a day's grace unless immediate). */
  rotateAiGatewayToken?(projectId: string, immediate: boolean): Promise<{ gateway: AiGatewayInfo; graceEndsAt: string | null }>;
  /** X2: store the project's own provider key (never returned). */
  setAiProviderKey?(projectId: string, provider: AiProviderId, key: string): Promise<AiGatewayInfo>;
  /** X2: remove the project's own provider key. */
  removeAiProviderKey?(projectId: string, provider: AiProviderId): Promise<{ removed: boolean }>;
  /** X2: what a request would cost (worst case the gateway reserves, a typical figure, cheaper models). */
  estimateAiCost?(projectId: string, input: AiEstimateInput): Promise<AiEstimateInfo>;
  /** X2: the request log (metadata only). */
  listAiRequests?(projectId: string, query: { model?: string; status?: AiGatewayRequestInfo['status'] }): Promise<{ requests: AiGatewayRequestInfo[]; cursor: string | null }>;
  /** A8: the account's usage against its plan's allowance, spending state and notices (billing access only). */
  getBillingUsage?(query: { accountId?: string; month?: string }): Promise<BillingUsage>;
  /** A8: the account's plan, members and spending limit. */
  getBillingPlan?(accountId?: string): Promise<BillingPlanView>;
  /** A8: change the plan (billing.manage; an agent connection must be account-wide). */
  setPlan?(input: { accountId?: string; plan: 'free' | 'pro' | 'team' }): Promise<BillingPlanChange>;
  /** A8: set or turn off the monthly spending limit (USD cents). */
  setSpendCap?(input: { accountId?: string; enabled: boolean; amount?: number }): Promise<BillingPlanView>;
  /** A8: the upcoming invoice as it stands. */
  getInvoicePreview?(accountId?: string): Promise<InvoicePreview>;
  /**
   * P2 (§8.5): claim an anonymous deploy with its claim token — it is redeployed into a new project in
   * this connection's account (an apps-domain address, no expiry) and the anonymous copy is deleted.
   */
  claimDeployment?(token: string, options: { projectName?: string | null; accountId?: string | null }): Promise<ClaimedDeployment>;
  /** A9: connect a GitHub repository (granted to the Create GitHub App) to a project. */
  connectGitHubRepo?(projectId: string, input: GitHubConnectInput): Promise<{ link: GitHubLink; deploying: boolean }>;
  /** A9: the project's preview environments. */
  listPreviews?(projectId: string, includeClosed: boolean): Promise<Preview[]>;
  /** E3: promote an edge deployment to production (a preview is copied without a rebuild; a production version becomes current and the rollback pin clears). */
  promote?(deploymentId: string, idempotencyKey: string, options: { allowBuildTimeDrift?: boolean }): Promise<PromoteAccepted>;
  /** E3: the project's direct (non-GitHub) previews. */
  listEdgePreviews?(projectId: string, includeClosed: boolean): Promise<EdgePreview[]>;
  /** E3: edge usage this month against the plan's allowance. */
  edgeUsage?(projectId: string): Promise<EdgeUsage>;
  /** E3: the project's edge settings in force (preview TTL, whether old production addresses answer). */
  getEdgeSettings?(projectId: string): Promise<EdgeSettings>;
  /** E3: change them (previewTtlDays null = the default). */
  setEdgeSettings?(projectId: string, change: EdgeSettingsChange): Promise<EdgeSettings>;
  /** D1: the account's registered domains (read only; ordering and changes are in the dashboard). */
  listDomains?(accountId?: string): Promise<DomainList>;
  /** D1: one registered domain by name. */
  getDomain?(name: string, accountId?: string): Promise<DomainRegistration>;
  /** A6: managed Postgres. */
  createDatabase?(projectId: string, spec: DatabaseSpec, idempotencyKey: string): Promise<{ database: Database }>;
  listDatabases?(projectId: string): Promise<Database[]>;
  getDatabase?(databaseId: string): Promise<Database>;
  updateDatabase?(databaseId: string, patch: DatabasePatch): Promise<{ database: Database }>;
  listDatabaseBackups?(databaseId: string): Promise<{ backups: DatabaseBackup[]; recoveryWindow: { from: string | null; to: string | null; pitr: boolean } }>;
  /** A6 (people only: a grant never holds apps.data.admin): `create db connect`. */
  connectDatabase?(databaseId: string, input: { minutes?: number; clientIp?: string }): Promise<DatabaseConnectSession>;
  /** A5: the project's persistent volumes. */
  listVolumes?(projectId: string): Promise<Volume[]>;
  /** A5: create a volume, optionally attached to a web or worker service of its environment. */
  addVolume?(projectId: string, input: VolumeInput, idempotencyKey: string): Promise<{ volume: Volume; created: boolean }>;
  /** A5: take a manual snapshot of a volume now. */
  snapshotVolume?(volumeId: string): Promise<VolumeSnapshot>;
  /** A5: the project's managed Valkey instances. */
  listValkey?(projectId: string): Promise<Valkey[]>;
  /** A5: add a managed Valkey (Redis-compatible) to an environment. */
  addValkey?(projectId: string, input: ValkeyInput, idempotencyKey: string): Promise<{ valkey: Valkey; created: boolean }>;
  /** A5: back a Valkey up now (Pro; kept 7 days). */
  backupValkey?(valkeyId: string): Promise<ValkeyBackup>;
  /** A5: a Valkey's backups, newest first. */
  listValkeyBackups?(valkeyId: string): Promise<ValkeyBackup[]>;
  /** A7: a project's alerting — rules, channels, open and recent alerts, recent notifications. */
  getAlerts?(projectId: string): Promise<AlertsOverview>;
  /** A7: add an alert rule. */
  createAlertRule?(projectId: string, input: AlertRuleInput): Promise<AlertRule>;
  /** A7: change an alert rule (enable / disable, parameters, channels, quiet hours, re-notify). */
  updateAlertRule?(ruleId: string, change: AlertRuleChange): Promise<AlertRule>;
  /** A7: remove an alert rule and its alerts. */
  deleteAlertRule?(ruleId: string): Promise<{ removed: boolean }>;
  /** A7: add a channel; a webhook channel's signing secret is in the answer once. */
  createAlertChannel?(projectId: string, input: AlertChannelInput): Promise<{ channel: AlertChannel; signingSecret: string | null }>;
  /** A7: remove a channel (rules stop notifying it). */
  deleteAlertChannel?(channelId: string): Promise<{ removed: boolean }>;
  /** A7: queue one test notification to a channel. */
  testAlertChannel?(channelId: string): Promise<{ notificationId: string }>;
}

// ---------------------------------------------------------------------------------------------
// P2: anonymous, claimable deploys (spec §8.5) — no account, no token
// ---------------------------------------------------------------------------------------------

/** An anonymous deploy as the unauthenticated endpoints show it. The claim token is never in here. */
export type AnonymousDeploy = {
  id: string;
  status: 'building' | 'deploying' | 'live' | 'failed' | 'expired' | 'claimed';
  url: string | null;
  expiresAt: string;
  deploymentId: string | null;
  kind: 'bundle' | 'static' | 'framework';
  framework: string | null;
  target: 'edge';
  failure: { failedStep: string; message: string } | null;
};

/** The answer to the deploy itself: the only time the claim token and link are shown. */
export type AnonymousDeployCreated = AnonymousDeploy & { reason: string; claimToken: string; claimUrl: string; banner: string };

export type ClaimedDeployment = {
  anonymousId: string;
  project: { id: string; name: string; accountId: string };
  deployment: { id: string; status: string; serviceId: string };
  url: string | null;
  target: 'edge';
};

export interface AnonymousBackend {
  deploy(tarball: Uint8Array): Promise<AnonymousDeployCreated>;
  status(id: string): Promise<AnonymousDeploy>;
}
