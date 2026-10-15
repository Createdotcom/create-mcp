import { z } from 'zod';

/**
 * App hosting P2 (spec 2026-09-25 §8.3 path 4, §8.5): anonymous, claimable deploys and the "Deploy to
 * Create" button. Shared by the API (limits, claim links), the dispatch Worker (the anonymous banner),
 * the hosting MCP / CLI (limits they check before uploading) and the dashboard (claim and clone pages).
 */

/**
 * The platform account every unclaimed anonymous project belongs to. It has no members, so no person
 * or grant can ever see it through the account model; only the anonymous-deploy service acts in it,
 * with an access it builds itself. A claim deploys the project's retained source into a NEW project
 * in the claimant's account and tears this one down.
 */
export const APPS_ANON_ACCOUNT_ID = 'acct_create_anonymous';

/** What one anonymous deploy may upload (§8.5 caps). Enforced while the archive streams, so a gzip bomb costs at most `maxUnpackedBytes`. */
export const APPS_ANON_LIMITS = {
  /** The gzipped tarball as sent. */
  maxCompressedBytes: 5 * 1024 * 1024,
  /** Everything it unpacks to. */
  maxUnpackedBytes: 25 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 1000,
  /** A compressed archive that inflates more than this many times over is refused as a bomb, whatever its absolute size. */
  maxInflationRatio: 100,
  /** Unclaimed deploys are deleted, with everything in them, after this long (§8.5 "TTL 72 hours"). */
  ttlHours: 72,
} as const;

/** §8.5 "per source IP and /64 — 3 deploys per hour, 10 per day". */
export const APPS_ANON_RATE = { perIpHour: 3, perIpDay: 10 } as const;

/** The banner every HTML page of an unclaimed deploy carries (§8.5), removable only by claiming. */
export const APPS_ANON_BANNER_TEXT = 'Deployed anonymously on Create — claim it';

/** The dashboard page a claim link opens (`#token=…`, in the fragment); without a token it explains what a claim link is. */
export const APPS_ANON_CLAIM_PATH = '/account/apps/claim';

/** Claim tokens: 32 random bytes after this prefix, shown once, stored only as SHA-256. */
export const APPS_ANON_CLAIM_TOKEN_PREFIX = 'ccl_';
export const APPS_ANON_CLAIM_TOKEN_PATTERN = /^ccl_[A-Za-z0-9_-]{43}$/;

/**
 * The Pro plan as the resume brief (2026-09-26 §9) proposes it — shown on the claim page's "what Pro
 * unlocks" line. A proposal until slice A8 sets prices; the page says so.
 */
export const APPS_PRO_PLAN_PROPOSAL = { monthlyCents: 1400, members: 3 } as const;

/**
 * Extract a claim token from a pasted claim URL or a bare token; null when neither. The token lives
 * ONLY in the URL fragment (`#token=ccl_…`): a fragment is never sent to a server, so it cannot land
 * in access logs, proxies or a Referer (security review M5). A `?token=` query is deliberately NOT
 * read, so no Create surface ever learns to put one there.
 */
export function claimTokenFrom(input: string): string | null {
  const trimmed = input.trim();
  if (APPS_ANON_CLAIM_TOKEN_PATTERN.test(trimmed)) return trimmed;
  const hash = trimmed.startsWith('#') ? trimmed : (() => {
    try {
      return new URL(trimmed).hash;
    } catch {
      return '';
    }
  })();
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && APPS_ANON_CLAIM_TOKEN_PATTERN.test(token) ? token : null;
}

/** The claim link for a token: the dashboard's claim page with the token in the FRAGMENT. */
export function claimLink(dashboardUrl: string, token: string): string {
  const url = new URL(APPS_ANON_CLAIM_PATH, dashboardUrl);
  url.hash = `token=${token}`;
  return url.toString();
}

/** An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) as its IPv4 form; anything else unchanged. */
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(v);
  return mapped ? mapped[1]! : v;
}

/** Second-level labels under which a registrable domain has three labels (`example.co.uk`). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'gv']);

/**
 * An approximation of a host's registrable domain (eTLD+1) without the full Public Suffix List: the
 * last two labels, or three under a ccTLD's common second level (`example.co.uk`). Used only to REFUSE
 * configurations (security review M3), where erring towards "the same site" is the safe direction.
 */
export function registrableDomain(host: string): string {
  const labels = host.trim().toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const take = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** A comma-separated CIDR list entry: an IPv4 or IPv6 address with an optional in-range prefix. */
export function isValidCidr(value: string): boolean {
  const [addr, prefix, extra] = value.trim().split('/');
  if (extra !== undefined || !addr) return false;
  const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(addr);
  const v6 = !v4 && addr.includes(':') && anonAddressBucket(addr) !== 'unknown';
  if (!v4 && !v6) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (v4 ? 32 : 128);
}

/**
 * The address bucket an anonymous deploy is rate-limited under: an IPv4 address as is, an IPv6
 * address by its /64 (one customer's allocation, §8.5), and every request whose address cannot be
 * established in ONE shared bucket — for anonymous deploys a missing signal must be stricter, not
 * looser.
 */
export function anonAddressBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const v = ip.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return `v4:${v}`;
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(v);
  if (mapped) return `v4:${mapped[1]}`;
  if (!v.includes(':')) return 'unknown';
  const [head, tail] = v.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return 'unknown';
  return `v6:${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** True when `host` is `domain` or a name under it. */
export function isUnderDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/\.$/, '');
  return h === d || h.endsWith(`.${d}`);
}

// ---------------------------------------------------------------------------------------------
// "Deploy to Create" button (§8.3 path 4)
// ---------------------------------------------------------------------------------------------

/** The dashboard page a Deploy button opens. */
export const DEPLOY_BUTTON_PATH = '/new/clone';

const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

/**
 * A repository's `create.json` as far as the Deploy button reads it: the environment variables to
 * prompt for. Other keys (start command, health check, sizes — §8.3 path 1) are allowed and ignored
 * here. `env` may also be a plain list of names, the shape Vercel's `env=` parameter takes.
 */
export const CreateManifestEnvSchema = z.union([
  z.array(EnvKey).max(50),
  z
    .record(
      EnvKey,
      z
        .object({
          description: z.string().max(500).optional(),
          // Review LOW: only an https link is ever shown; anything else is dropped (the prompt stays).
          link: z.string().max(2048).optional().transform((u) => (u && /^https:\/\/\S+$/.test(u) && URL.canParse(u) ? u : undefined)),
          required: z.boolean().default(true),
          secret: z.boolean().default(true),
        })
        .strict(),
    )
    .refine((r) => Object.keys(r).length <= 50, 'at most 50 variables'),
]);

export const CreateManifestSchema = z.looseObject({ env: CreateManifestEnvSchema.optional() });

export type DeployButtonEnvPrompt = { key: string; description: string | null; link: string | null; required: boolean; secret: boolean };

/** The prompts a manifest's `env` asks for, in its order. */
export function envPromptsFromManifest(manifest: unknown): DeployButtonEnvPrompt[] {
  const parsed = CreateManifestSchema.safeParse(manifest);
  if (!parsed.success || !parsed.data.env) return [];
  const env = parsed.data.env;
  if (Array.isArray(env)) return env.map((key) => ({ key, description: null, link: null, required: true, secret: true }));
  return Object.entries(env).map(([key, v]) => ({ key, description: v.description ?? null, link: v.link ?? null, required: v.required, secret: v.secret }));
}

/** A public GitHub repository the Deploy button may clone: `https://github.com/<owner>/<repo>` only. */
export type GitHubRepository = { owner: string; repo: string; url: string };

export function parseGitHubRepository(raw: string): GitHubRepository | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.replace(/\.git$/, '').replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export type DeployButtonParams = {
  repository: GitHubRepository | null;
  /** Variables named in the URL (`env=A,B`), with the shared description/link Vercel's parameters carry. */
  env: DeployButtonEnvPrompt[];
  projectName: string | null;
  ref: string | null;
  /** Why the link cannot be used, in plain words; empty when it can. */
  problems: string[];
};

/**
 * The Deploy button URL's query, Vercel-compatible where Vercel has a name for it
 * (`repository-url`, `env`, `envDescription`, `envLink`, `project-name`) plus `ref`. Unknown
 * parameters are ignored.
 */
export function parseDeployButtonParams(search: URLSearchParams): DeployButtonParams {
  const problems: string[] = [];
  const rawRepo = search.get('repository-url') ?? search.get('repository');
  const repository = rawRepo ? parseGitHubRepository(rawRepo) : null;
  if (!rawRepo) problems.push('The link does not name a repository (repository-url).');
  else if (!repository) problems.push('Only public GitHub repositories (https://github.com/<owner>/<repo>) can be deployed with this button.');
  const description = search.get('envDescription')?.slice(0, 500) ?? null;
  const link = search.get('envLink');
  const safeLink = link && /^https:\/\//.test(link) ? link.slice(0, 2048) : null;
  const keys = (search.get('env') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const env: DeployButtonEnvPrompt[] = [];
  for (const key of keys.slice(0, 50)) {
    if (!EnvKey.safeParse(key).success) {
      problems.push(`"${key.slice(0, 40)}" is not a valid variable name.`);
      continue;
    }
    if (!env.some((e) => e.key === key)) env.push({ key, description, link: safeLink, required: true, secret: true });
  }
  const name = search.get('project-name');
  const projectName = name && /^[a-z][a-z0-9-]{0,39}$/.test(name) ? name : null;
  const ref = search.get('ref');
  const safeRef = ref && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..') ? ref : null;
  return { repository, env, projectName, ref: safeRef, problems };
}

/** A Deploy button link for a repository (what template READMEs paste). */
export function deployButtonUrl(dashboardUrl: string, input: { repositoryUrl: string; env?: string[]; projectName?: string }): string {
  const url = new URL(DEPLOY_BUTTON_PATH, dashboardUrl);
  url.searchParams.set('repository-url', input.repositoryUrl);
  if (input.env && input.env.length > 0) url.searchParams.set('env', input.env.join(','));
  if (input.projectName) url.searchParams.set('project-name', input.projectName);
  return url.toString();
}

/** The badge image (a fixed SVG: no user input is ever rendered into it). */
export const DEPLOY_BUTTON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="148" height="32" viewBox="0 0 148 32" role="img" aria-label="Deploy to Create">' +
  '<title>Deploy to Create</title>' +
  '<rect width="148" height="32" rx="6" fill="#111111"/>' +
  '<path d="M16 9l7 12H9z" fill="#ffffff"/>' +
  '<text x="32" y="21" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" font-size="13" font-weight="600">Deploy to Create</text>' +
  '</svg>';
