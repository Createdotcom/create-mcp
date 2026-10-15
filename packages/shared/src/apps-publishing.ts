import type { AppsCapability, AppsSize } from './apps-hosting';

/**
 * Create App Hosting, slice P1 — agent publishing (spec 2026-09-25 §8). The grant model shared by the
 * API (authorization server, `/v1/apps/*`, the hosting MCP), the dashboard's consent screen and the
 * `create` CLI, so all four read one definition.
 *
 * A GRANT is what a person gives an AI tool (an OAuth client) or a CLI: one account, a project scope,
 * a set of apps capabilities, a monthly spend limit, a size ceiling and an expiry (§8.1). Tokens are
 * minted against a grant and die with it.
 */

/**
 * The OAuth scopes a client may ask for, and the §2.2 capability each one carries. `apps.secrets.read`
 * and `apps.data.admin` have NO scope at all: no OAuth grant, however it was consented to, can read a
 * secret back or restore a database (§8.1 "never in a default grant"; P1 makes it never, full stop).
 * `apps.tokens` has none either: a grant cannot mint grants.
 */
export const APPS_OAUTH_SCOPES = {
  'apps:read': 'apps.view',
  'apps:deploy': 'apps.deploy',
  'apps:configure': 'apps.configure',
  'apps:delete': 'apps.delete',
} as const satisfies Record<string, AppsCapability>;
export type AppsOAuthScope = keyof typeof APPS_OAUTH_SCOPES;
export const APPS_OAUTH_SCOPE_LIST = Object.keys(APPS_OAUTH_SCOPES) as AppsOAuthScope[];

/** The capabilities a grant can ever hold. */
export const APPS_GRANTABLE_CAPABILITIES: readonly AppsCapability[] = Object.values(APPS_OAUTH_SCOPES);

/** §8.1 default agent grant: view, deploy, configure (write secrets, never read them), delete what it created. */
export const APPS_DEFAULT_AGENT_SCOPES: readonly AppsOAuthScope[] = ['apps:read', 'apps:deploy', 'apps:configure', 'apps:delete'];

export function appsCapabilitiesForScopes(scopes: readonly string[]): AppsCapability[] {
  const out = new Set<AppsCapability>();
  for (const s of scopes) {
    const cap = (APPS_OAUTH_SCOPES as Record<string, AppsCapability | undefined>)[s];
    if (cap) out.add(cap);
  }
  return [...out];
}

export function appsScopesForCapabilities(capabilities: readonly string[]): AppsOAuthScope[] {
  return APPS_OAUTH_SCOPE_LIST.filter((s) => capabilities.includes(APPS_OAUTH_SCOPES[s]));
}

/**
 * §8.1 project scope:
 * - `created` — "projects this grant creates" (the default for agents: it can create projects and sees only those);
 * - `selected` — the projects the person picked at consent, plus any the grant creates;
 * - `account` — every project in the account: an explicit owner choice with a fresh second factor, never the default.
 */
export const APPS_GRANT_PROJECT_SCOPES = ['created', 'selected', 'account'] as const;
export type AppsGrantProjectScope = (typeof APPS_GRANT_PROJECT_SCOPES)[number];

/**
 * §8.1 size ceiling default: "no dedicated-CPU sizes, max 2 GB per service" — `L` is the largest
 * shared size (2 GB). A person may lower it at consent, or raise it only on an account-wide grant.
 */
export const APPS_DEFAULT_SIZE_CEILING: AppsSize = 'L';
export const APPS_SHARED_SIZES: readonly AppsSize[] = ['S', 'M', 'L'];

/**
 * §8.1 spend limit default: +$20/month (the Pro default; Hobby's "$0 extra" arrives with plans in A8).
 * Cents, per calendar month, evaluated server-side on every cost-increasing action.
 */
export const APPS_DEFAULT_GRANT_SPEND_LIMIT_CENTS = 2_000;
export const APPS_MAX_GRANT_SPEND_LIMIT_CENTS = 100_000;

/**
 * PROPOSAL prices (§9.1, founder-only numbers, not decided). Used ONLY to evaluate a grant's spend
 * limit against the monthly run-rate of what the grant created until slice A8's metered rollup
 * replaces the estimate. Changing a number here changes no invoice: nothing bills from this table.
 */
export const APPS_SIZE_MONTHLY_CENTS_PROPOSAL: Readonly<Record<AppsSize, number>> = {
  S: 500,
  M: 1_000,
  L: 2_000,
  XL: 4_000,
  '2XL': 8_000,
  '4XL': 16_000,
};

/** Grant lifetimes. An agent grant defaults to 90 days; a person may pick 1–365 at consent. */
export const APPS_DEFAULT_GRANT_DAYS = 90;
export const APPS_MAX_GRANT_DAYS = 365;

/** Token lifetimes (seconds). Access tokens are short; refresh tokens rotate on every use. */
export const APPS_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const APPS_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const APPS_AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
export const APPS_AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const APPS_DEVICE_CODE_TTL_SECONDS = 15 * 60;
export const APPS_DEVICE_POLL_INTERVAL_SECONDS = 5;

/**
 * Token shapes. `cat_` is the spec's access-token prefix (§8.1); refresh tokens get their own prefix
 * so one can never be presented where the other is expected. 43 base64url characters = 32 random
 * bytes. Only SHA-256 hashes are stored.
 */
export const APPS_ACCESS_TOKEN_PATTERN = /^cat_[A-Za-z0-9_-]{43}$/;
export const APPS_REFRESH_TOKEN_PATTERN = /^catr_[A-Za-z0-9_-]{43}$/;

/** The device flow's user code: 8 letters from an unambiguous alphabet, shown as XXXX-XXXX. */
export const APPS_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const APPS_USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export function normalizeUserCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** The first-party CLI's pre-registered public client (RFC 8628 device flow; no secret). */
export const APPS_CLI_CLIENT_ID = 'create-cli';

/** Path of the hosting MCP endpoint on the API origin (§8.2 hosts it on the API service as a Hono route). */
export const APPS_MCP_PATH = '/mcp/apps';

/** The machine-readable error every agent-facing failure carries (§8.4). */
export type AppsAgentProblem = {
  code: string;
  message: string;
  /** One imperative sentence saying what to do next. */
  fix: string;
  docs_url?: string;
  missing_capability?: string;
};
