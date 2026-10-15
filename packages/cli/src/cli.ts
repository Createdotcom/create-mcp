import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APPS_ANON_LIMITS, APPS_MCP_SERVER_INFO, AgentError, EDGE_MANIFEST_FILE, billingSummary, HttpAnonymousBackend, HttpAppsBackend, callTool, runStdio, type AnonymousDeploy, type Deployment, type LogLine, type ToolContext, type ToolResult } from '@create/apps-mcp';
import { AuthError, accessToken, login, logout } from './auth.js';
import { DEFAULT_API_URL, LinkError, readLink, writeLink } from './config.js';
import { PackError, packDirectory } from './pack.js';
import { localEdgeBuild, realLocalEdgeBuilder, type LocalEdgeBuilder } from './edge-build.js';

/**
 * `create` — deploy to Create from a terminal or an AI agent (spec §8.3). Every command is a thin
 * layer over the same curated tools the hosting MCP serves (`@create/apps-mcp`), run against the
 * Admin API with the CLI's own sign-in, so the CLI, `create mcp` and the remote MCP endpoint share
 * one set of rules and one set of error messages. `--json` prints one JSON object on stdout for
 * agents; progress and prompts go to stderr.
 */

export type CliIo = {
  stdout: Writable;
  stderr: Writable;
  stdin?: Readable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openBrowser?: (url: string) => void;
  /** Reads a secret value: a hidden prompt on a terminal, else all of stdin. Never argv. */
  readSecret?: (prompt: string) => Promise<string>;
  /** Aborts long-running commands (`logs --follow`): Ctrl-C in the terminal. */
  signal?: AbortSignal;
  /**
   * A6 `create db connect`: run psql with the session in its ENVIRONMENT (PGPASSWORD never on a command
   * line). Absent (tests, no psql): the command prints how to connect without the password.
   */
  runPsql?: (env: Record<string, string>) => Promise<number>;
  /** The local edge builder (`--build local`, edge-only projects). Default: build-local.mjs from the Create checkout; tests inject a fake. */
  edgeBuilder?: LocalEdgeBuilder;
  /**
   * Asks a question on the terminal and resolves the typed line. Only used when `interactive` is true
   * (stdin and stderr are a terminal): `create deploy` / `create link` in an unlinked folder ask which
   * project to use. Agents (no terminal) never see a prompt.
   */
  prompt?: (question: string) => Promise<string>;
  interactive?: boolean;
};

export const VERSION = '0.1.2';

const HELP = `create — deploy apps to Create

Usage: create <command> [options]

Commands:
  login                    Sign in (shows a code to approve in your browser)
  logout                   Sign out and revoke this computer's sign-in
  deploy                   Deploy this folder (or --image <ref>) and wait until it is live:
                           Next.js, Astro, SvelteKit, React Router, Nuxt and static sites that
                           can run on the edge are built for the edge, anything else as a
                           container (the output says which, and why); a folder with
                           create-edge.json is a pre-built edge bundle, live at once
  deploy [--project <name|id>] [--create] [--yes]
                           In a folder not linked yet: on a terminal it asks which project (or
                           creates one, named after the folder); --project links an existing
                           project (created when missing), --create / --yes create without asking
  mcp [--local-builds] [--build-env NAME]
                           Serve the hosting MCP tools over stdio for a local AI agent. --local-builds
                           lets it build framework source on THIS machine (runs the folder's npm
                           scripts as you; the person confirms each folder once when the client can ask)
  deploy --build local|remote
                           Where framework source is built: on Create (remote), or on this machine
                           into an edge bundle (local; automatic for edge-only projects). Build-time
                           variables beyond the allowlist: --build-env NAME (repeatable)
  link [--project <name|id>] [--create]
                           Link this folder to a project (asks on a terminal) without deploying
  deploy --anonymous       Deploy this folder WITHOUT signing in: static files only (an index.html
                           and its assets, already built) on a preview URL, deleted after 72 hours unless claimed; prints a
                           claim link once
  deploy --preview [--branch <name>]
                           Deploy this folder as a PREVIEW of a branch (default: the folder's git
                           branch): a stable branch URL plus a permanent URL for this deploy,
                           never production secrets, not indexed; production is untouched
  promote <deploymentId>   Make a preview (or a staged production deploy) live in production, without
                           rebuilding (--allow-build-time-drift: even if build-time values differ)
  usage                    Edge usage this month (requests, CPU, bandwidth) against the plan
  claim <claim link>       Move an anonymous deploy into your account (a new project, no expiry)
  status                   Show the linked project's services and deployments
  logs [--build]           Show recent log lines (--since 15m|2h|1d|<ISO time>, --search <text>,
                           --level debug|info|warn|error, --lines <n>)
  logs --follow            Keep printing new lines as they arrive (Ctrl-C to stop)
  metrics [metric]         cpu, memory, requests, errors or latency (default: all that apply)
                           over --since (default 1h)
  env set KEY=value [...]  Set plain variables (values may reference \${{KEY}}, \${{shared.KEY}}, \${{service.KEY}})
  env set KEY --secret     Set a secret: the value is read from stdin or a hidden prompt, never the command line
                           add --build-time to also hand a variable to builds (secrets as build secrets only)
  env list                 List the production environment's variables (secret values are never shown)
  env unset KEY [...]      Remove variables
  domains [list]           List the service's addresses (default and custom)
  domains add <hostname>   Claim a custom domain; prints the TXT and CNAME records to create
  domains verify <id>      Check the TXT record and set the domain up (repeat until active)
  domains apex add <example.com> [--redirect www.example.com] [--hsts]
                           Add a bare domain; prints the TXT, A/AAAA and CNAME records (apex gateway)
  domains apex verify <id> Check its TXT and A/AAAA records (repeat until active)
  domains apex [list|remove <id>]
  domains remove <id>      Detach a custom domain
  images domains [list]    List the hosts remote images may be optimized from, and this month's usage
  images domains add <host> [...]
                           Allow image hosts for /_create/image (cdn.example.com, *.example.com,
                           https://cdn.example.com/images/**); https only, effective at once
  images domains rm <host> [...]
                           Stop allowing image hosts
  analytics on|off         Turn Web Analytics + Speed Insights on or off for the linked project
                           (no cookies, no IP addresses stored; effective at once)
  analytics [--from <date>] [--to <date>] [--granularity hour|day]
                           Page views, visitors, top pages, referrers, countries (default: 7 days)
  analytics speed          Core Web Vitals (p75 of LCP, INP, CLS, TTFB, FCP) overall and per route
  protection               How previews, deployment addresses and production are protected, and the share links
  protection set [--previews m] [--deployments m] [--production m] [--preflight refuse|pass]
                           m: off | account (members sign in with Create) | password | link (share links only)
  protection password [--remove]
                           Set the preview password (read from stdin or a hidden prompt, never the command line)
  protection sign-out      Sign every visitor out of the protected addresses
  protection share         Share links are created in the dashboard (a signed-in person, never a token)
  protection revoke <linkId>
                           Revoke a share link (its visitors are signed out within a minute)
  comments [--status open|resolved|all] [--path /page]
                           Comments your team left on protected previews with the preview toolbar
  comments reply <threadId> <text…>
                           Reply to a comment thread (plain text)
  comments resolve <threadId> | comments reopen <threadId>
                           Resolve or reopen a comment thread
  firewall                 The edge firewall: rules in order (first match wins), rate limits, bot policy
  firewall block <ip-or-cidr>… | allow <ip-or-cidr>… | block-country <CC>…
                           Add a deny (or allow, placed first) rule; --position n, --name "…"
  firewall challenge <path>… [--methods POST]
                           Ask visitors to those paths to prove they are human (Turnstile)
  firewall rate-limit <path> --limit n [--window 10|60|300|600|3600] [--methods POST] [--algorithm sliding|fixed]
                           Requests per window per client address; over it → 429
  firewall bot off|challenge|deny [--threshold 1-99]
                           Challenge or deny likely bots (Pro); verified bots pass
  firewall delete <ruleId> Delete a rule or rate limit
  compose import [file]    Preview importing a Docker Compose file (default compose.yaml / docker-compose.yml)
                           into the linked project: what moves, what changes, what cannot run and why.
                           --value KEY=value (plain), --ask-secret KEY (hidden prompt; never the command
                           line), --container <service> (keep a postgres/redis image as a container),
                           --env <id>, --no-deploy; add --yes to apply exactly the previewed plan
  import vercel --connection <id> [--from <vercel project>]
                           Move a Vercel project into the linked project. Connect Vercel in the dashboard
                           first (the token never goes through the CLI); without --from, lists the projects.
                           Shows what moves, what changes and what is not carried over; --yes applies it.
                           --service name, --target auto|edge|container, --storage blob=keep,postgres=create,
                           --ask-secret KEY (values Vercel does not reveal), --skip KEY, --no-domains,
                           --no-crons, --no-github, --no-deploy
  import status <importId> An import's data copies and their progress
  scale                    The linked service's replicas, autoscaler and sleep-on-idle, and what the plan allows
  scale [--replicas n] [--max n|off] [--cpu 20-95] [--sleep 15m|2h|off] [--size S…4XL] [--now]
                           Change them (--max: autoscale on CPU up to n, Pro/Team; --sleep: scale to zero
                           after that long without a request, woken by the next one; --now: roll out now)
  wake [--service name]    Wake the linked sleeping web service now (it sleeps again after its idle window)
  egress                   The project's static egress IP (container services' outbound address)
  egress on|off            Turn it on (Pro, monthly price) or off (the address stays reserved 30 days)
  review                   Whether Create is reviewing the project (a hold and its notice) and how to appeal
  domains [name]           The account's registered domains (status, expiry, renewal, lock, privacy,
                           nameservers), or one of them; order and change domains in the dashboard
  edge-settings            Days a preview may go without a deploy before it is removed, and whether old
                           production deployments keep answering at their own address
  edge-settings set [--ttl days|default] [--old-addresses on|off]
                           Change them (--ttl 1-90; --old-addresses on re-opens retained old production addresses)
  alerts                   The project's alerting: open alerts, rules and channels
  alerts add <signal> [--threshold n] [--window minutes] [--service name] [--channels id,id]
                           [--renotify minutes] [--quiet HH:MM-HH:MM@Time/Zone]
                           Add a rule (signals: deployment_failed, service_crashloop, service_oom, error_rate,
                           latency_p95, database_storage, valkey_memory, spend_cap, ai_limit, workflow_failed,
                           cron_failed, domain_problem)
  alerts on|off|rm <ruleId>
                           Enable, disable (closes its alerts quietly) or remove a rule
  alerts channel add email [--roles owner,administrator] | webhook | slack [--name text]
                           Add where alerts go (members by role; a signed webhook — its secret is shown once;
                           a Slack or Discord incoming webhook). URLs are read from a hidden prompt or stdin
  alerts channel rm|test <channelId>
                           Remove a channel, or send it a test alert
  private                  Private networking: which web services only this project's edge frontends reach
  private on|off [--service name]
                           Make the linked web service private to the project (frontends in its environment
                           get CREATE_BACKEND_URL_<NAME> and a per-deployment CREATE_BACKEND_TOKEN_<NAME>) or public
  private rotate-keys [--emergency]
                           Rotate the project's backend-token signing key (--emergency: old tokens stop now)
  sandbox                  The project's running sandboxes (--all: ended ones too)
  sandbox create [--image base|node22|python313] [--size small|medium|large] [--lifetime s] [--idle s]
                 [--internet] [--port n] [--snapshot id] [--name "…"]
                           Start an isolated machine for untrusted code; prints its id
  sandbox exec <id> [--cwd dir] [--timeout s] -- <command> [args…]
                           Run a command in it; its stdout/stderr are printed and its exit code is ours
  sandbox write <id> <path> --from <local-file>   Write a file under /workspace
  sandbox read <id> <path>                        Print a file from /workspace
  sandbox ls <id> [path]                          List a directory under /workspace
  sandbox expose <id> <port> [--ttl s]            A signed, short-lived URL for a port
  sandbox snapshot <id> [--name "…"] | snapshots | delete-snapshot <snapshotId>
  sandbox extend <id> --minutes <n>               Move its end later (never past the plan's maximum lifetime)
  sandbox stop <id>                               Stop it (its workspace is deleted)
  blob stores              List the project's Create Blob stores (usage, quota, URL, token variable)
  blob create <name> [--private] [--inline-images] [--variable NAME]
                           Create a blob store; its token lands in every environment as
                           CREATE_BLOB_READ_WRITE_TOKEN (or NAME) for @create/blob
  blob ls [prefix] [--store <name|id>] [--cursor c]
                           List blobs (pathname order; --cursor for the next page)
  blob put <file> [pathname] [--store …] [--random-suffix] [--overwrite] [--content-type t] [--multipart]
                           Upload a file (streamed straight to storage); prints its URL
                           Files over 100 MB (or with --multipart) go up in parts
  blob rm <pathname> [...] [--store …]
                           Delete blobs
  blob rotate [--store …]  Rotate the store's token in every environment
  queues                   List the project's queues and workflows (backlog, runs, today's usage, last error)
  queues create <name> [--service <id> --path /api/q] [--max-attempts n] [--env <id>]
                           Create a queue: push (Create POSTs each message, signed, to that path) or
                           pull (no --service). Reference \${{queues.<NAME>_URL}} / _TOKEN / _SIGNING_SECRET
  queues send <queue> <json> [--delay 5m] [--dedupe key]
                           Send a message (a JSON value; anything else is sent as text)
  queues dead <queue>      List dead letters (ids, attempts, last error — never bodies)
  queues redrive <queue>   Put every dead letter back on the queue
  queues rotate <queue|workflow> [--immediate]
                           New token and signing secret (the old ones work for a day unless --immediate)
  queues schedule <queue|workflow> "<cron>" [json]
                           Send a message / start a run on a UTC cron schedule
  queues rm <queue|workflow> --confirm <name>
                           Delete it and everything it holds
  workflows create <name> --service <id> --path /api/workflows/x [--max-attempts n]
                           Create a durable workflow served by @create/queues workflow()
  workflows start <workflow> [json] [--key idempotency-key]
  workflows runs <workflow> [--status failed]
  workflows run <workflow> <runId>
                           One run and its recorded steps (names only)
  workflows cancel|retry <workflow> <runId>
  ai                       The project's AI Gateway: on/off, models and prices, tokens, this month's spend
  ai enable [--models a,b] [--limit 25]
                           Turn it on (OpenAI-compatible; reference \${{ai.AI_GATEWAY_URL}} and \${{ai.AI_GATEWAY_TOKEN}})
  ai disable               Turn it off (every token is refused until it is on again)
  ai limit <usd>           Set the hard monthly limit on usage of Create's keys
  ai models [--tools] [--long-context] [--reasoning] [--vision] [--embeddings]
                           Every model cheapest first: price per 1M tokens, cost index (×1 = Claude
                           Sonnet 5), tier, which key answers; the filters keep the models that can
                           (the first line is the cheapest that can); then the aliases (create/cheap …)
  ai estimate [model] --max-tokens N (--input-bytes N | --input-tokens N) [--tools] [--images N]
                           What one request would cost: typical, the worst case held, cheaper models
                           (--embedding-inputs N: an embeddings request of N inputs, no max-tokens)
  ai default <model|alias|none>
                           What a request without a model (or create/default) uses
  ai policy [--deny-countries CN] [--allow-countries US,FR] [--deny-providers a,b]
            [--allow-providers a,b] [--regions US,EU,global] [--open-weights-only]
            [--no-aggregators] [--reset]
                           Show or change the project's model policy (merged onto the one in force)
  ai token create <name> [--models a,b]
                           An API token for local development or CI (shown once)
  ai token revoke <id>     Revoke an API token at once
  ai rotate [--immediate]  Rotate the reference token (the old one works for a day unless --immediate)
  ai key set <provider>
                           Use your own provider key (read from stdin or a hidden prompt, never argv)
  ai key rm <provider>
  ai requests [--model id] [--status failed]
                           Recent requests: model, tokens, cost, status — never prompts
  db [list]                List the project's Postgres databases (references, never credentials)
  db add [name]            Add a Postgres database (--size, --storage <GB>, --ha, --extensions a,b)
  db backups <name>        List a database's backups and its recovery window
  db connect <name>        Open psql through a temporary login: only from your IP, TLS with SCRAM
  db edge <name> on|off|rotate
                           Open a database to this environment's edge frontends through Hyperdrive (then set a
                           frontend variable to \${{<name>.HYPERDRIVE}}), close it, or rotate its Access token
                           channel binding, valid --minutes (default 15, at most 60). Needs a person's
                           data-admin permission; the password is never printed
  volumes                  List the linked project's persistent volumes and Valkey databases
  volumes add <mount path> [--size-gb <n>] [--name <name>]
                           Give the linked service a persistent disk (it then runs one replica,
                           restarts stop-then-start, and mounts it from its next deploy)
  volumes snapshot <name|id>
                           Back a volume up now (kept 30 days; daily backups are automatic).
                           Restoring and deleting are done in the dashboard
  valkey add [name] [--size <S|M|…>] [--storage-gb <n>] [--eviction <policy>]
                           Add a managed Valkey (Redis-compatible, default name cache) and set the
                           shared REDIS_URL to reference it; the password is never shown
  valkey backup <name|id>  Back a Valkey up now (Pro; encrypted, kept 7 days; daily backups are
                           automatic). Restoring (into a new Valkey) is done in the dashboard
  valkey backups <name|id> List a Valkey's backups (daily, manual, final)
  rollback [deploymentId]  Roll back to the previous (or given) live deployment
  link --github [owner/repo]
                           Connect this project to a GitHub repository (default: this folder's
                           github.com origin): pushes deploy, pull requests get preview URLs. Needs
                           a dashboard sign-in: from the CLI it says where to connect it instead
  previews [--all]         List the project's pull-request and branch previews (--all: closed too)
  mcp                      Run the Create hosting MCP server over stdio for a local AI tool
  whoami                   Show this sign-in's account, permissions and limits
  usage --billing [--month YYYY-MM]
                           The account's usage this month against its plan's allowance, the usage
                           charges so far, the spending limit and the upcoming invoice (outside a
                           linked folder, plain 'usage' shows this)
  plan                     The account's plan (Free, Pro or Team), members and spending limit
  plan free|pro|team       Change the plan: upgrades apply now (prorated invoice), downgrades
                           when the month ends
  plan cap <usd>|off       Set the monthly spending limit on usage, or turn it off

Options:
  --json                   Machine-readable output (one JSON object on stdout)
  --account <id>           With usage/plan/domains: the account (when you can see several)
  --anonymous              With deploy: no sign-in, a preview with a claim link (see above)
  --project <name>         Project to create or use (default: the folder name)
  --service <name>         Service name (default: web)
  --image <ref>            Deploy a container image instead of the folder
  --dir <path>             Folder to deploy (default: the current folder)
  --size <S|M|L|…>         Service size (default S)
  --target <auto|edge|container>
                           Where to run it (default auto: Create detects the framework)
  --edge / --server        Shorthand for --target edge / --target container
  --no-wait                Do not wait for the deployment to go live
  --allow-secret-file <p>  Upload this one credential file anyway (.env, keys, .npmrc …; repeat per file)
  --api-url <url>          Create API (default ${DEFAULT_API_URL}, or CREATE_API_URL)
`;

type Flags = Record<string, string | boolean | string[]>;

export function parseArgs(argv: string[]): { command: string[]; flags: Flags } {
  const command: string[] = [];
  const flags: Flags = {};
  const valued = new Set(['redirect', 'project', 'service', 'image', 'dir', 'size', 'api-url', 'lines', 'region', 'allow-secret-file', 'target', 'branch', 'from', 'to', 'granularity', 'since', 'search', 'level', 'store', 'variable', 'cursor', 'content-type', 'storage', 'extensions', 'minutes', 'client-ip', 'month', 'account', 'size-gb', 'storage-gb', 'name', 'eviction', 'previews', 'deployments', 'production', 'preflight', 'path', 'max-attempts', 'env', 'delay', 'dedupe', 'confirm', 'key', 'status', 'models', 'limit', 'model', 'window', 'methods', 'threshold', 'position', 'algorithm', 'replicas', 'max', 'cpu', 'sleep', 'value', 'ask-secret', 'container', 'file', 'lifetime', 'idle', 'port', 'snapshot', 'ttl', 'cwd', 'timeout', 'old-addresses', 'input-bytes', 'input-tokens', 'max-tokens', 'images', 'embedding-inputs', 'deny-providers', 'allow-providers', 'deny-countries', 'allow-countries', 'regions', 'connection', 'skip', 'import', 'channels', 'quiet', 'renotify', 'roles', 'build-env']);
  const repeatable = new Set(['allow-secret-file', 'value', 'ask-secret', 'container', 'skip', 'build-env']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      // `--build` is a switch for `create logs --build` and takes a value only for `create deploy
      // --build local|remote|auto` (the next word, or `--build=local`).
      if (key === 'build') {
        const next = argv[i + 1];
        if (inline !== undefined) flags.build = inline;
        else if (next === 'local' || next === 'remote' || next === 'auto') {
          flags.build = next;
          i += 1;
        } else flags.build = true;
        continue;
      }
      if (valued.has(key)) {
        const value = inline ?? argv[i + 1];
        if (inline === undefined) i += 1;
        if (value === undefined) throw new CliError('missing_value', `--${key} needs a value`, `Pass --${key} <value>.`);
        if (repeatable.has(key)) flags[key] = [...((flags[key] as string[] | undefined) ?? []), value];
        else flags[key] = value;
      } else {
        flags[key] = true;
      }
    } else {
      command.push(a);
    }
  }
  return { command, flags };
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

/**
 * What a folder holds, for the edge-only fallback: a pre-built bundle, something that can be built for
 * the edge (package.json or a static index.html, no Dockerfile), a container (a Dockerfile), or neither.
 */
export function folderKind(dir: string): 'edge-bundle' | 'edge-capable' | 'container' | 'other' {
  if (existsSync(join(dir, EDGE_MANIFEST_FILE))) return 'edge-bundle';
  if (existsSync(join(dir, 'Dockerfile'))) return 'container';
  if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'index.html'))) return 'edge-capable';
  return 'other';
}

/** `--build auto|local|remote`: where framework source is built (default auto: on Create when the project has compute). */
export function buildFrom(flags: Flags): 'auto' | 'local' | 'remote' {
  const b = flags.build;
  if (b === undefined || b === true) return 'auto';
  if (b === 'auto' || b === 'local' || b === 'remote') return b;
  throw new CliError('usage', `--build is auto, local or remote, not ${String(b)}`, 'Pass --build local (build on this machine) or --build remote (build on Create).');
}

/** E2: `--target auto|edge|container`, or the `--edge` / `--server` shorthands. */
export function targetFrom(flags: Flags): 'auto' | 'edge' | 'container' {
  const chosen = [flags.edge === true ? 'edge' : null, flags.server === true ? 'container' : null, typeof flags.target === 'string' ? flags.target : null].filter((v): v is string => v !== null);
  if (new Set(chosen).size > 1) throw new CliError('usage', 'Choose one target', 'Pass one of --target auto|edge|container, --edge or --server.');
  const t = chosen[0] ?? 'auto';
  if (t !== 'auto' && t !== 'edge' && t !== 'container') throw new CliError('usage', `Unknown target "${t}"`, 'Pass --target auto, --target edge or --target container.');
  return t;
}

/** A9: `owner/repo` of this folder's `origin` remote when it is on github.com (read from .git/config; git is never run). */
export function githubOrigin(dir: string): string | null {
  let config: string;
  try {
    config = readFileSync(join(dir, '.git', 'config'), 'utf8');
  } catch {
    return null;
  }
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? '';
  const url = /^\s*url\s*=\s*(\S+)\s*$/m.exec(section)?.[1] ?? '';
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1]! : null;
}

/** `--since`: a relative duration (`90s`, `15m`, `2h`, `3d`) back from now, or an ISO 8601 time. */
/** X3: `--delay 5m` → seconds (a number, or 30s / 15m / 2h / 7d). */
export function parseDurationFlag(value: string): number {
  const m = /^(\d{1,9})\s*(s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new CliError('usage', `Not a duration: ${value}`, 'Use seconds, or 30s, 15m, 2h, 7d.');
  const unit = m[2] ?? 's';
  return Number(m[1]) * (unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400);
}

export function sinceToIso(value: string, nowMs: number): string {
  const m = /^(\d{1,6})([smhd])$/.exec(value.trim());
  if (m) return new Date(nowMs - Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']).toISOString();
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new CliError('usage', `--since ${value} is not a duration or a time`, 'Pass e.g. --since 15m, --since 2h, --since 1d or --since 2026-09-28T10:00:00Z.');
  return new Date(t).toISOString();
}

/** E3: the folder's checked-out branch, from `.git/HEAD` (null when detached or not a repository). */
export function currentBranch(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(m[1]!) ? m[1]! : null;
  } catch {
    return null;
  }
}

function projectNameFrom(dir: string): string {
  const cleaned = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
  return (cleaned || 'app').slice(0, 40);
}

/**
 * A verified hostname under a zone in Create's own Cloudflare account (APPS_EDGE_ACCOUNT_ZONES, the API
 * reports sslStatus `account_zone`) is routed in Create at once, but traffic reaches the edge only
 * through a Worker route on that zone, which Create's operators add.
 */
export const ACCOUNT_ZONE_ROUTE_NOTE =
  'Note: this hostname is in a zone Create manages, so it serves traffic only once it is in the edge routes (on staging: STAGING_APPS_EDGE_ROUTES, then the deploy-staging-edge workflow). Until then its DNS keeps serving whatever it serves today.';

function out(io: CliIo, json: boolean, human: string, data: Record<string, unknown>): void {
  if (json) io.stdout.write(`${JSON.stringify(data)}\n`);
  else io.stdout.write(`${human}\n`);
}

function toolData(result: ToolResult): Record<string, unknown> {
  if (result.isError) {
    const err = (result.structuredContent?.error ?? {}) as { code?: string; message?: string; fix?: string };
    throw new CliError(err.code ?? 'error', err.message ?? result.content[0]?.text ?? 'Failed', err.fix ?? '');
  }
  return result.structuredContent ?? {};
}

/** Refuses a path outside `root` (both resolved through symlinks). */
export function assertInside(root: string, path: string): void {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(resolve(root));
    realPath = realpathSync(resolve(root, path));
  } catch {
    throw new CliError('not_a_directory', `${path} does not exist`, 'Pass a folder inside the directory create mcp was started in.');
  }
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new CliError('outside_working_directory', `${path} is outside ${realRoot}`, 'Deploy a folder inside the directory create mcp was started in, or start create mcp in the project folder.');
  }
}

/** A secret from stdin: a hidden prompt on a terminal, otherwise everything piped in (one trailing newline dropped). */
async function readSecretFrom(io: CliIo, prompt: string): Promise<string> {
  const input = (io.stdin ?? process.stdin) as NodeJS.ReadStream;
  if (input.isTTY && typeof input.setRawMode === 'function') {
    io.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    return new Promise((resolveValue) => {
      let value = '';
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            input.setRawMode(false);
            input.pause();
            input.off('data', onData);
            io.stderr.write('\n');
            resolveValue(value);
            return;
          }
          if (ch === '\u0003') process.exit(130);
          value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
        }
      };
      input.on('data', onData);
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  let flags: Flags = {};
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    const json = flags.json === true;
    const [cmd, ...rest] = parsed.command;
    const apiUrl = String(flags['api-url'] ?? io.env.CREATE_API_URL ?? DEFAULT_API_URL).replace(/\/$/, '');
    const say = (line: string) => io.stderr.write(`${line}\n`);
    const authIo = { fetchImpl: io.fetchImpl, sleep: io.sleep, now: io.now, say, env: io.env, openBrowser: io.openBrowser };

    if (!cmd || cmd === 'help' || flags.help) {
      io.stdout.write(HELP);
      return 0;
    }
    if (cmd === 'version' || flags.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (cmd === 'login') {
      await login(apiUrl, authIo);
      out(io, json, 'Signed in to Create.', { ok: true, api_url: apiUrl });
      return 0;
    }
    if (cmd === 'logout') {
      const was = await logout(apiUrl, authIo);
      out(io, json, was ? 'Signed out; this computer’s sign-in was revoked.' : 'You were not signed in.', { ok: true, signed_out: was });
      return 0;
    }

    // P2 (§8.5): no sign-in, no link, no project — a preview on the anonymous domain with a claim link.
    if (cmd === 'deploy' && flags.anonymous === true) {
      if (typeof flags.image === 'string') throw new CliError('usage', 'Anonymous deploys take a folder, not an image', 'Drop --image, or sign in (create login) and deploy the image to a project of your own.');
      if (flags.server === true || flags.target === 'container') throw new CliError('usage', 'Anonymous deploys run on the edge only', 'Drop --server / --target container, or sign in (create login) to deploy a server.');
      const dir = resolve(io.cwd, String(flags.dir ?? '.'));
      const edge = existsSync(join(dir, EDGE_MANIFEST_FILE));
      say(`Packaging ${dir} for an anonymous preview …`);
      const pack = packDirectory(dir, { allowSecretFiles: [], gitignore: !edge });
      if (pack.tarball.byteLength > APPS_ANON_LIMITS.maxCompressedBytes) {
        throw new CliError('anonymous_upload_too_large', `The folder packs to ${(pack.tarball.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${APPS_ANON_LIMITS.maxCompressedBytes / 1024 / 1024} MB anonymous limit`, 'Deploy only the build output (add the rest to .createignore), or sign in (create login) and run create deploy.');
      }
      const anonymous = new HttpAnonymousBackend({ apiUrl, fetchImpl: io.fetchImpl, userAgent: `create-cli/${VERSION}` });
      const created = await anonymous.deploy(pack.tarball);
      say(created.reason);
      let preview: AnonymousDeploy = created;
      if (flags['no-wait'] !== true) {
        const deadline = io.now() + 10 * 60 * 1000;
        while ((preview.status === 'building' || preview.status === 'deploying') && io.now() < deadline) {
          await io.sleep(3000);
          preview = await anonymous.status(created.id);
          say(`… ${preview.status}`);
        }
      }
      const data = { anonymous: true, id: created.id, status: preview.status, url: preview.url, expires_at: created.expiresAt, claim_url: created.claimUrl, target: 'edge', kind: created.kind, framework: created.framework, failure: preview.failure, files: pack.fileCount, skipped: pack.skipped };
      const human = [
        `Preview ${created.id}: ${preview.status}${preview.url ? ` at ${preview.url}` : ''}.`,
        `Claim link (shown only once — keep it): ${created.claimUrl}`,
        `Open it signed in to Create to keep the app. Unclaimed, it is deleted with everything in it at ${created.expiresAt}, and every page shows a banner until then.`,
      ].join('\n');
      out(io, json, human, data);
      return preview.status === 'failed' ? 1 : 0;
    }

    const backend = new HttpAppsBackend({
      apiUrl,
      token: () => accessToken(apiUrl, authIo),
      refresh: async () => accessToken(apiUrl, authIo, true).catch(() => null),
      fetchImpl: io.fetchImpl,
      userAgent: `create-cli/${VERSION}`,
    });
    const dir = resolve(io.cwd, String(flags.dir ?? '.'));
    const allowSecretFiles = (flags['allow-secret-file'] as string[] | undefined) ?? [];
    const build = buildFrom(flags);
    const buildEnvNames = (flags['build-env'] as string[] | undefined) ?? [];
    for (const name of buildEnvNames) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CliError('usage', `--build-env takes a variable NAME, not ${name}`, 'Pass --build-env NAME (its value comes from this shell, e.g. --build-env SENTRY_AUTH_TOKEN).');
    // `create mcp`: a model asks, so building on this machine (running the folder's npm scripts) is off
    // unless the person started the server with --local-builds. `create deploy`: the person asked.
    const buildLocally = localEdgeBuild({ builder: io.edgeBuilder ?? realLocalEdgeBuilder, envNames: buildEnvNames, env: io.env, say, buildOutput: (chunk) => io.stderr.write(chunk), mode: cmd === 'mcp' ? 'mcp' : 'terminal', localBuildsAllowed: flags['local-builds'] === true });
    /** A model driving `create mcp` may only touch folders inside the directory the CLI was started in. */
    const localFolder = (path: string) => {
      const abs = resolve(io.cwd, path);
      if (cmd === 'mcp') assertInside(io.cwd, abs);
      return abs;
    };
    const asAgentError = (error: unknown): never => {
      if (error instanceof CliError || error instanceof PackError || error instanceof LinkError) throw new AgentError(error.code, error.message, error.fix);
      throw error;
    };
    const ctx: ToolContext = {
      backend,
      transport: 'stdio',
      scopes: null,
      packDirectory: async (path) => {
        // A model driving `create mcp` may only package folders inside the directory the CLI was
        // started in (symlinks resolved), never an arbitrary path on the machine.
        try {
          if (cmd === 'mcp') assertInside(io.cwd, path);
          // E1: a folder with create-edge.json at its root is a pre-built edge bundle.
          const edge = existsSync(join(resolve(path), EDGE_MANIFEST_FILE));
          const pack = packDirectory(path, { allowSecretFiles, gitignore: !edge });
          return { tarball: pack.tarball, sha256: pack.sha256, fileCount: pack.fileCount, skipped: pack.skipped, edge };
        } catch (error) {
          // Surface as a tool error the model can act on, not an internal failure.
          if (error instanceof CliError || error instanceof PackError) throw new AgentError(error.code, error.message, error.fix);
          throw error;
        }
      },
      buildEdgeLocally: async (path, options) => {
        try {
          return await buildLocally(localFolder(path), options);
        } catch (error) {
          return asAgentError(error);
        }
      },
      folderLink: {
        read: (path) => {
          try {
            return readLink(localFolder(path));
          } catch (error) {
            return asAgentError(error);
          }
        },
        write: (path, value) => {
          try {
            writeLink(localFolder(path), value);
          } catch (error) {
            asAgentError(error);
          }
        },
      },
      progress: say,
      localPath: (path) => {
        try {
          return localFolder(path);
        } catch (error) {
          return asAgentError(error);
        }
      },
      folderKind: (path) => folderKind(resolve(io.cwd, path)),
    };
    const call = async (name: string, args: Record<string, unknown>) => toolData(await callTool(name, args, ctx));
    /** N1: the structured result plus the tool's text (`text`), which the firewall and egress commands print. */
    const callText = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown> & { text: string }> => {
      const result = await callTool(name, args, ctx);
      return { ...toolData(result), text: result.content.map((c) => c.text).join('\n') };
    };

    if (cmd === 'mcp') {
      // Fail fast (to stderr) when not signed in, rather than answering every tool call with it.
      await accessToken(apiUrl, authIo);
      await runStdio(ctx, { serverInfo: APPS_MCP_SERVER_INFO, input: io.stdin ?? process.stdin, output: io.stdout });
      return 0;
    }

    if (cmd === 'whoami') {
      const data = await call('get_usage', {});
      out(io, json, JSON.stringify(data, null, 2), data);
      return 0;
    }

    // A8: the account's plan, usage and spending limit — the account's billing access decides, not the project link.
    // In a folder linked to a project, plain `create usage` is the project's edge usage (E3) followed by
    // the account's billing summary; --billing, --account or --month ask for the account's usage alone.
    const projectUsage = cmd === 'usage' && flags.billing !== true && flags.account === undefined && flags.month === undefined && readLink(dir) !== null;
    if ((cmd === 'usage' && !projectUsage) || cmd === 'plan') {
      const accountId = typeof flags.account === 'string' ? flags.account : undefined;
      const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
      if (!backend.getBillingUsage || !backend.getBillingPlan || !backend.setPlan || !backend.setSpendCap || !backend.getInvoicePreview) throw new CliError('not_available', 'Billing is not available through this connection', 'Update the create CLI.');
      if (cmd === 'usage') {
        if (flags.month !== undefined && !(typeof flags.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(flags.month))) throw new CliError('usage', '--month is YYYY-MM', 'Pass e.g. --month 2026-09.');
        const usage = await backend.getBillingUsage({ ...(accountId ? { accountId } : {}), ...(typeof flags.month === 'string' ? { month: flags.month } : {}) });
        const preview = flags.month ? null : await backend.getInvoicePreview(accountId ?? usage.accountId);
        const lines = billingSummary(usage);
        for (const m of usage.meters.filter((x) => x.quantity > 0 || x.amount > 0)) {
          lines.push(`  ${m.label.padEnd(30)} ${m.display.quantity.padStart(16)}${m.included > 0 ? ` of ${m.display.included} (${m.percentOfAllowance}%)` : ''}${m.amount > 0 ? `  ${money(m.amount)}` : ''}`);
        }
        if (preview) lines.push(`Upcoming invoice (issued ${preview.issuesOn}): ${money(preview.subtotal)} so far before tax — ${preview.lines.map((l) => `${l.description} ${money(l.amount)}`).join('; ') || 'nothing'}.`);
        out(io, json, lines.join('\n'), { usage, ...(preview ? { invoice_preview: preview } : {}) });
        return 0;
      }
      const [sub, value] = rest;
      if (sub === undefined) {
        const view = await backend.getBillingPlan(accountId);
        const human = [
          `${view.plan.name} plan (${money(view.plan.monthlyAmount)}/month)${view.pendingPlan ? `, moving to ${view.pendingPlan} when the month ends` : ''}.`,
          `Members: ${view.members.count}${view.members.limit !== null ? ` of ${view.members.limit}` : ''}.`,
          `Spending limit: ${view.cap.enabled ? money(view.cap.amount ?? 0) : 'off'}${view.cap.editable ? '' : ' (Free stops at its allowance)'}; ${money(view.spending.spent)} used this month, state ${view.spending.state}.`,
          ...(view.pausedProjects.length ? [`Paused for spending: ${view.pausedProjects.map((p) => p.name).join(', ')}.`] : []),
          `Plans: ${view.plans.map((p) => `${p.name} ${money(p.monthlyAmount)}/month${p.memberLimit !== null ? ` (up to ${p.memberLimit} members)` : ''}`).join(', ')}.`,
        ];
        out(io, json, human.join('\n'), { plan: view });
        return 0;
      }
      if (sub === 'cap') {
        if (value === undefined) throw new CliError('usage', 'Say the limit in dollars, or off', 'Use `create plan cap 100` or `create plan cap off`.');
        const off = value === 'off';
        const dollars = Number(value);
        if (!off && !(Number.isFinite(dollars) && dollars >= 0 && dollars <= 100_000)) throw new CliError('usage', `Not a dollar amount: ${value}`, 'Use `create plan cap 100` or `create plan cap off`.');
        const view = await backend.setSpendCap({ ...(accountId ? { accountId } : {}), enabled: !off, ...(off ? {} : { amount: Math.round(dollars * 100) }) });
        out(io, json, view.cap.enabled ? `The monthly spending limit is ${money(view.cap.amount ?? 0)}.` : 'The monthly spending limit is off.', { plan: view });
        return 0;
      }
      if (sub !== 'free' && sub !== 'pro' && sub !== 'team') throw new CliError('usage', `Unknown plan: ${sub}`, 'Use `create plan`, `create plan free|pro|team`, or `create plan cap <usd>|off`.');
      const change = await backend.setPlan({ ...(accountId ? { accountId } : {}), plan: sub });
      out(io, json, change.message, { change });
      return 0;
    }

    let link = readLink(dir);
    const requireLink = () => {
      if (!link) throw new CliError('not_linked', 'This folder is not linked to a Create project', 'Run create deploy here first (it creates and links a project).');
      return link;
    };

    /**
     * Vercel-style linking for a folder with no `.create/project.json`: `--project` names an existing
     * project (by name or id) — linked — or a new one; `--create`/`--yes`, or no terminal (agents),
     * create one named after the folder as before; on a terminal the person picks from their projects.
     * Resolves null when a new project should be created with the returned name.
     */
    const pickProject = async (service: string): Promise<{ linked: { projectId: string; projectName: string } | null; newName: string }> => {
      const folderName = projectNameFrom(dir);
      const listed = async () => ((await call('list_projects', {})).projects as { id: string; name: string; status: string }[]).filter((p) => p.status === 'active');
      const linkTo = (p: { id: string; name: string }) => {
        writeLink(dir, { projectId: p.id, projectName: p.name, service });
        say(`Linked this folder to ${p.name} (.create/project.json).`);
        return { linked: { projectId: p.id, projectName: p.name }, newName: p.name };
      };
      if (typeof flags.project === 'string') {
        const hit = (await listed()).find((p) => p.id === flags.project || p.name === flags.project);
        return hit ? linkTo(hit) : { linked: null, newName: flags.project };
      }
      if (flags.create === true || flags.yes === true || !io.interactive || !io.prompt) return { linked: null, newName: folderName };
      const projects = await listed();
      if (projects.length > 0) {
        say(`This folder is not linked to a Create project yet.`);
        projects.slice(0, 30).forEach((p, i) => say(`  ${i + 1}) ${p.name}`));
        say(`  n) Create a new project`);
        const answer = (await io.prompt(`Link to which project? [n] `)).trim().toLowerCase();
        const n = Number(answer);
        if (answer && answer !== 'n' && !(Number.isInteger(n) && n >= 1 && n <= Math.min(projects.length, 30))) throw new CliError('usage', `Not a choice: ${answer}`, 'Run it again and type a number from the list, or n.');
        if (answer && answer !== 'n') return linkTo(projects[n - 1]!);
      }
      const typed = (await io.prompt(`Name for the new project [${folderName}] `)).trim();
      return { linked: null, newName: typed || folderName };
    };

    if (cmd === 'link' && flags.github !== true) {
      if (link && typeof flags.project !== 'string' && flags.create !== true) {
        out(io, json, `This folder is linked to ${link.projectName} (.create/project.json). Pass --project <name> to link another.`, { project_id: link.projectId, project: link.projectName, linked: true });
        return 0;
      }
      const service = String(flags.service ?? link?.service ?? 'web');
      const picked = await pickProject(service);
      let chosen = picked.linked;
      if (!chosen) {
        const createArgs = { name: picked.newName, ...(flags.region ? { region: flags.region } : {}) };
        let created: { id: string; name: string };
        try {
          created = (await call('create_project', createArgs)).project as { id: string; name: string };
        } catch (error) {
          // As create deploy: no compute in the region → an edge-only project (sites are built on this machine).
          if (!(error instanceof CliError && error.code === 'region_unavailable')) throw error;
          created = (await call('create_project', { ...createArgs, edge_only: true })).project as { id: string; name: string };
          say('This region has no compute capacity, so the project was created edge-only: sites are built on this machine into an edge bundle.');
        }
        writeLink(dir, { projectId: created.id, projectName: created.name, service });
        say(`Created project ${created.name} and linked this folder (.create/project.json).`);
        chosen = { projectId: created.id, projectName: created.name };
      }
      out(io, json, `Linked to ${chosen.projectName}. Deploy with create deploy.`, { project_id: chosen.projectId, project: chosen.projectName, linked: true });
      return 0;
    }

    if (cmd === 'deploy') {
      const service = String(flags.service ?? link?.service ?? 'web');
      let projectId = link?.projectId;
      let projectName = link?.projectName ?? String(flags.project ?? projectNameFrom(dir));
      if (!projectId) {
        const picked = await pickProject(service);
        if (picked.linked) {
          projectId = picked.linked.projectId;
          link = { ...picked.linked, service };
        }
        projectName = picked.newName;
      }
      if (!projectId) {
        const createArgs = { name: projectName, ...(flags.region ? { region: flags.region } : {}) };
        let created: { id: string; name: string };
        try {
          created = (await call('create_project', createArgs)).project as { id: string; name: string };
        } catch (error) {
          // A pre-built edge bundle needs no compute, and framework source can be built on this machine
          // into one: where the region has none, ask for an edge-only project explicitly (it stays
          // edge-only; containers and builds on Create need a new project).
          const kind = folderKind(dir);
          const edgeCapable = typeof flags.image !== 'string' && targetFrom(flags) !== 'container' && (kind === 'edge-bundle' || (kind === 'edge-capable' && build !== 'remote'));
          if (!(error instanceof CliError && error.code === 'region_unavailable' && edgeCapable)) throw error;
          created = (await call('create_project', { ...createArgs, edge_only: true })).project as { id: string; name: string };
          say(existsSync(join(dir, EDGE_MANIFEST_FILE)) ? 'This region has no compute capacity, so the project was created for pre-built edge bundles only.' : 'This region has no compute capacity, so the project was created edge-only: this folder is built on this machine into an edge bundle.');
        }
        projectId = created.id;
        projectName = created.name;
        writeLink(dir, { projectId, projectName, service });
        say(`Created project ${projectName} and linked this folder (.create/project.json).`);
      }
      const common = { project_id: projectId, service, ...(flags.size ? { size: flags.size } : {}) };
      const target = targetFrom(flags);
      let result: Record<string, unknown>;
      if (flags.preview === true) {
        // E3: a preview of this branch — never production. The branch: --branch, else this folder's current branch.
        if (typeof flags.image === 'string') throw new CliError('usage', 'Previews deploy a folder, not an image', 'Drop --image, or deploy the image to production without --preview.');
        const branch = typeof flags.branch === 'string' ? flags.branch : currentBranch(dir);
        say(`Packaging ${dir} as a preview${branch ? ` of branch ${branch}` : ''} …`);
        result = await call('deploy_preview_env', { project_id: projectId, service, path: dir, ...(branch ? { branch } : {}), ...(build !== 'auto' ? { build } : {}) });
      } else if (typeof flags.image === 'string') {
        if (target !== 'auto') throw new CliError('usage', '--target applies to deploying a folder, not an image', 'Drop --target (an image always runs as a container), or deploy the folder.');
        result = await call('deploy_image', { ...common, image: flags.image });
      } else {
        const prebuilt = existsSync(join(dir, EDGE_MANIFEST_FILE));
        say(prebuilt ? `Packaging the edge bundle in ${dir} (${EDGE_MANIFEST_FILE}) …` : `Packaging ${dir} …`);
        result = await call('deploy_directory', { ...common, path: dir, ...(prebuilt ? {} : { target, ...(build !== 'auto' ? { build } : {}) }) });
        // E2: the control plane's decision — where it runs and why — printed before the wait.
        if (typeof result.reason === 'string') say(result.reason);
        for (const w of (result.warnings as string[] | undefined) ?? []) say(`warning: ${w}`);
      }
      let deployment = result.deployment as { id: string; status: string; failure?: unknown; url?: string | null };
      const url = deployment.url ?? (typeof result.url === 'string' ? result.url : null);
      if (flags['no-wait'] !== true) {
        const deadline = io.now() + 10 * 60 * 1000;
        while (!['live', 'failed', 'cancelled', 'superseded'].includes(deployment.status) && io.now() < deadline) {
          await io.sleep(3000);
          deployment = (await call('get_deployment', { deployment_id: deployment.id })).deployment as typeof deployment;
          say(`… ${deployment.status}`);
        }
      }
      const decision = result.target ? { target: result.target, framework: result.framework ?? null, reason: result.reason ?? null, overridden: result.overridden ?? false, warnings: result.warnings ?? [] } : {};
      const deploymentUrl = (result.deployment as { deployment_url?: string | null }).deployment_url ?? null;
      const staged = (result.deployment as { staged?: boolean }).staged === true;
      const data = { project_id: projectId, project: projectName, service, deployment, ...decision, ...(url ? { url, edge: true } : {}), ...(deploymentUrl ? { deployment_url: deploymentUrl } : {}), ...(flags.preview === true ? { preview: result.preview ?? true } : {}), ...(staged ? { staged } : {}), ...(result.skipped ? { skipped: result.skipped } : {}) };
      const human = [
        staged
          ? `Deployment ${deployment.id} is staged, NOT live: production is pinned by a rollback. Check it at ${deploymentUrl ?? 'its deployment address'}, then run \`create promote ${deployment.id}\` to make it live.`
          : `Deployment ${deployment.id}: ${deployment.status}${url && deployment.status === 'live' ? ` at ${url}` : ''}.`,
        deploymentUrl && !staged ? `This exact version: ${deploymentUrl}` : '',
        flags.preview === true && deployment.status === 'live' ? `Preview only — production is untouched. To go live: create promote ${deployment.id}` : '',
      ];
      out(io, json, human.filter(Boolean).join('\n'), data);
      return deployment.status === 'failed' ? 1 : 0;
    }

    if (cmd === 'claim') {
      const link = rest[0];
      if (!link) throw new CliError('usage', 'create claim needs the claim link', 'Run create claim "<claim link>" (the link an anonymous deploy printed).');
      const data = await call('claim_deployment', { claim: link, ...(typeof flags.project === 'string' ? { project_name: flags.project } : {}) });
      const c = data.claimed as { project: { name: string }; url: string | null; deployment: { id: string; status: string } };
      out(io, json, `Claimed into project ${c.project.name}${c.url ? ` at ${c.url}` : ''} (deployment ${c.deployment.id}: ${c.deployment.status}).`, data);
      return 0;
    }

    if (cmd === 'status') {
      const l = requireLink();
      const data = await call('get_project', { project_id: l.projectId });
      const project = data.project as {
        name: string;
        status: string;
        environments?: { id: string; name: string; kind: string }[];
        services: { name: string; image: string; size: string; replicas: number; ready_replicas: number | null; current_deployment_id: string | null; environment_id?: string }[];
      };
      const environments = project.environments ?? [];
      // A preview environment's name is a hash (pv-…); its branch comes from the project's previews.
      const branches = new Map<string, string>();
      if (environments.some((e) => e.kind === 'preview')) {
        const r = await callTool('list_previews', { project_id: l.projectId, include_closed: false }, ctx).catch(() => null);
        if (r && !r.isError) {
          const sc = r.structuredContent ?? {};
          for (const p of (sc.previews as { environmentId?: string; kind?: string; pullRequest?: number | null; branch: string }[] | undefined) ?? []) {
            if (p.environmentId) branches.set(p.environmentId, p.kind === 'pull_request' && p.pullRequest ? `PR #${p.pullRequest}` : p.branch);
          }
          for (const p of (sc.direct_previews as { environmentId?: string; branch: string }[] | undefined) ?? []) if (p.environmentId) branches.set(p.environmentId, p.branch);
        }
      }
      const envLabel = (id: string | undefined) => {
        const e = environments.find((x) => x.id === id);
        if (!e) return null;
        if (e.kind === 'production') return 'production';
        if (e.kind === 'preview') return `preview ${branches.get(e.id) ?? e.name}`;
        return e.name;
      };
      const human = [
        `${project.name} — ${project.status}`,
        ...project.services.map((s) => {
          const label = envLabel(s.environment_id);
          return `  ${s.name}${label ? ` (${label})` : ''}: ${s.image} · ${s.size} · ${s.ready_replicas ?? 0}/${s.replicas} ready · current ${s.current_deployment_id ?? 'none'}`;
        }),
      ].join('\n');
      out(io, json, human, data);
      return 0;
    }

    if (cmd === 'logs') {
      const l = requireLink();
      const project = (await call('get_project', { project_id: l.projectId })).project as { services: { id: string; name: string }[] };
      const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
      if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)}`, 'Pass --service <name>, or deploy first.');
      const level = typeof flags.level === 'string' ? flags.level : undefined;
      if (level !== undefined && !['debug', 'info', 'warn', 'error'].includes(level)) throw new CliError('usage', `Unknown level "${level}"`, 'Pass --level debug, info, warn or error.');
      const search = typeof flags.search === 'string' ? flags.search : undefined;
      const since = typeof flags.since === 'string' ? sinceToIso(flags.since, io.now()) : undefined;
      const render = (x: LogLine) => `${x.at}${x.level ? ` ${x.level.toUpperCase()}` : ''}${x.source && x.source !== 'container' && x.stream === 'runtime' ? ` [${x.source}]` : ''} ${x.text}`;
      const data = await call('get_logs', {
        service_id: svc.id,
        type: flags.build ? 'build' : 'runtime',
        lines: Number(flags.lines ?? (flags.follow ? 50 : 200)),
        ...(since ? { since } : {}),
        ...(search && !flags.build ? { search } : {}),
        ...(level && !flags.build ? { level } : {}),
      });
      const lines = data.lines as LogLine[];
      if (flags.follow !== true || flags.build) {
        out(io, json, lines.map(render).join('\n') || 'No log lines yet.', data);
        return 0;
      }
      // --follow: the recent lines, then the live tail (reconnecting when the server ends a long stream).
      // With --json, one JSON object per line (NDJSON), so an agent can read it incrementally.
      const print = (x: LogLine) => io.stdout.write(json ? `${JSON.stringify(x)}\n` : `${render(x)}\n`);
      for (const x of lines) print(x);
      say(`Following ${svc.name}'s logs (Ctrl-C to stop) …`);
      for (;;) {
        const reason = await backend.followLogs(svc.id, { q: search ?? null, level: level ?? null }, print, io.signal, (count) => say(`… ${count} lines skipped (more than the live view shows per second; use create logs --since to read them all)`));
        if (reason === null || io.signal?.aborted) return 0;
        if (reason !== 'max_duration') {
          say(reason === 'access_revoked' ? 'The live view ended: this sign-in no longer has access.' : `The live view ended (${reason}).`);
          return reason === 'access_revoked' ? 1 : 0;
        }
      }
    }

    if (cmd === 'metrics') {
      const l = requireLink();
      const project = (await call('get_project', { project_id: l.projectId })).project as { services: { id: string; name: string; kind?: string }[] };
      const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
      if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)}`, 'Pass --service <name>, or deploy first.');
      const all = ['cpu', 'memory', 'requests', 'errors', 'latency'];
      const wanted = rest[0] ? [rest[0]] : all;
      for (const m of wanted) if (!all.includes(m)) throw new CliError('usage', `Unknown metric "${m}"`, `Pass one of ${all.join(', ')}.`);
      const since = sinceToIso(typeof flags.since === 'string' ? flags.since : '1h', io.now());
      const results: Record<string, unknown> = {};
      const human: string[] = [];
      for (const metric of wanted) {
        const r = await callTool('get_metrics', { service_id: svc.id, metric, since }, ctx);
        if (r.isError) {
          // One metric not applying to this kind of service (cpu for an edge frontend) must not hide the rest.
          const code = (r.structuredContent?.error as { code?: string } | undefined)?.code;
          if (!rest[0] && code === 'metric_not_available') continue;
          toolData(r);
        }
        results[metric] = r.structuredContent?.metrics ?? null;
        human.push(r.content[0]?.text ?? metric);
      }
      out(io, json, human.join('\n') || 'No metrics yet.', { service: svc.name, metrics: results });
      return 0;
    }

    if (cmd === 'env' && (rest[0] === 'list' || rest[0] === 'unset')) {
      const l = requireLink();
      const project = await backend.getProject(l.projectId);
      const production = project.environments.find((e) => e.kind === 'production');
      if (!production) throw new CliError('environment_not_found', 'The project has no production environment', 'Deploy first.');
      if (rest[0] === 'unset') {
        const keys = rest.slice(1);
        if (keys.length === 0) throw new CliError('usage', 'Usage: create env unset KEY [KEY2 …]', 'Name at least one variable.');
        const data = await call('set_variables', { project_id: l.projectId, set: [], remove: keys.map((key) => ({ key })) });
        out(io, json, `Removed ${keys.join(', ')}. Redeploy for running services to drop them.`, data);
        return 0;
      }
      const variables = await backend.listVariables(production.id);
      const nameOf = (id: string | null) => (id ? (project.services.find((s) => s.id === id)?.name ?? id) : 'all services');
      const human = variables.length
        ? variables.map((v) => `${v.key}${v.secret ? ' = (secret, hidden)' : ` = ${v.value}`}${v.buildTime ? ' [build time]' : ''} · ${nameOf(v.serviceId)}`).join('\n')
        : 'No variables yet.';
      out(io, json, human, { variables });
      return 0;
    }

    if (cmd === 'env') {
      const [sub, ...pairs] = rest;
      if (sub !== 'set' || pairs.length === 0) throw new CliError('usage', 'Usage: create env set KEY=value [KEY2=value2 …]  or  create env set KEY --secret', 'Pass at least one KEY=value, or one KEY with --secret.');
      const l = requireLink();
      const buildTime = flags['build-time'] === true;
      let set: { key: string; value: string; secret: boolean; build_time?: boolean }[];
      if (flags.secret === true) {
        // A secret on the command line lands in shell history and the process list: refuse it outright.
        if (pairs.length !== 1 || pairs[0]!.includes('=')) {
          throw new CliError('secret_in_argv', 'Secret values are never taken from the command line', 'Run `create env set KEY --secret` and type the value at the prompt, or pipe it in: `printf %s "$VALUE" | create env set KEY --secret`.');
        }
        const key = pairs[0]!;
        const value = await (io.readSecret ?? ((prompt: string) => readSecretFrom(io, prompt)))(`Value for ${key} (hidden): `);
        if (!value) throw new CliError('empty_secret', 'No value was given', 'Type the value at the prompt, or pipe it on stdin.');
        set = [{ key, value, secret: true }];
      } else {
        set = pairs.map((p) => {
          const eq = p.indexOf('=');
          if (eq < 1) throw new CliError('usage', `"${p}" is not KEY=value`, 'Write each variable as KEY=value, or set a secret with `create env set KEY --secret`.');
          return { key: p.slice(0, eq), value: p.slice(eq + 1), secret: false };
        });
      }
      if (buildTime) set = set.map((v) => ({ ...v, build_time: true }));
      const data = await call('set_variables', { project_id: l.projectId, set });
      out(io, json, `Set ${set.map((v) => v.key + (v.secret ? ' (secret)' : '')).join(', ')}. Redeploy for running services to pick them up.`, data);
      return 0;
    }

    if (cmd === 'domains') {
      const l = requireLink();
      const [sub = 'list', arg] = rest;
      const project = await backend.getProject(l.projectId);
      const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
      if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)}`, 'Pass --service <name>, or deploy first.');
      if (sub === 'list') {
        const list = await backend.listHostnames(svc.id);
        out(io, json, list.map((h) => `${h.hostname} · ${h.kind} · ${h.status}${h.kind === 'custom' ? ` · id ${h.id}` : ''}`).join('\n') || 'No addresses yet.', { hostnames: list });
        return 0;
      }
      if (sub === 'add') {
        if (!arg) throw new CliError('usage', 'Usage: create domains add <hostname>', 'Pass the hostname, e.g. www.example.com.');
        const data = await call('attach_domain', { service_id: svc.id, hostname: arg });
        const h = data.hostname as { id: string; hostname: string; verification: { type: string; name: string; value: string }[] };
        const records = h.verification.map((r) => `  ${r.type.padEnd(5)} ${r.name}  →  ${r.value}`).join('\n');
        out(io, json, `Claimed ${h.hostname}. Create these DNS records, then run \`create domains verify ${h.id}\`:\n${records}`, data);
        return 0;
      }
      if (sub === 'verify') {
        if (!arg) throw new CliError('usage', 'Usage: create domains verify <id>', 'Pass the id `create domains add` printed.');
        const data = await call('verify_domain', { hostname_id: arg });
        const h = data.hostname as { hostname: string; status: string; sslStatus?: string | null };
        out(io, json, [`${h.hostname}: ${h.status}`, h.status === 'active' && h.sslStatus === 'account_zone' ? ACCOUNT_ZONE_ROUTE_NOTE : ''].filter(Boolean).join('\n'), data);
        return 0;
      }
      if (sub === 'remove') {
        if (!arg) throw new CliError('usage', 'Usage: create domains remove <id>', 'Pass the id from `create domains list`.');
        const result = await backend.removeHostname(arg);
        out(io, json, result.removed ? 'Removed.' : 'Removal started; Create finishes it shortly.', result);
        return 0;
      }
      if (sub === 'apex') {
        // Bare domains (example.com): A/AAAA at Create's apex gateway, which redirects to a custom hostname.
        const [, apexSub = 'list', apexArg] = rest;
        if (!backend.listApexDomains || !backend.removeApexDomain) throw new CliError('not_available_yet', 'Bare domains are not available on this Create deployment', 'Use the www. address for now.');
        if (apexSub === 'list') {
          const list = await backend.listApexDomains(svc.id);
          out(io, json, list.map((a) => `${a.hostname} → ${a.redirectTo} · ${a.status} · DNS ${a.dns.status} · certificate ${a.certificate.status} · id ${a.id}`).join('\n') || 'No bare domains yet.', { apexDomains: list });
          return 0;
        }
        if (apexSub === 'add') {
          if (!apexArg) throw new CliError('usage', 'Usage: create domains apex add <example.com> [--redirect www.example.com] [--hsts]', 'Pass the bare domain.');
          const data = await call('add_apex_domain', { service_id: svc.id, hostname: apexArg, ...(flags.redirect ? { redirect_to: String(flags.redirect) } : {}), ...(flags.hsts ? { hsts: true } : {}) });
          const a = data.apex_domain as { id: string; hostname: string; redirectTo: string; records: { type: string; name: string; value: string }[] };
          const records = a.records.map((r) => `  ${r.type.padEnd(5)} ${r.name}  →  ${r.value}`).join('\n');
          out(io, json, `Added ${a.hostname} (redirects to ${a.redirectTo}). Create these DNS records (replace any other A/AAAA on ${a.hostname}), then run \`create domains apex verify ${a.id}\`:\n${records}`, data);
          return 0;
        }
        if (apexSub === 'verify') {
          if (!apexArg) throw new CliError('usage', 'Usage: create domains apex verify <id>', 'Pass the id `create domains apex add` printed.');
          const data = await call('verify_apex_domain', { apex_id: apexArg });
          const a = data.apex_domain as { hostname: string; status: string; dns: { status: string }; certificate: { status: string } };
          out(io, json, `${a.hostname}: ${a.status} (DNS ${a.dns.status}, certificate ${a.certificate.status})`, data);
          return 0;
        }
        if (apexSub === 'remove') {
          if (!apexArg) throw new CliError('usage', 'Usage: create domains apex remove <id>', 'Pass the id from `create domains apex list`.');
          out(io, json, 'Removed.', await backend.removeApexDomain(apexArg));
          return 0;
        }
        throw new CliError('usage', `Unknown domains apex command: ${apexSub}`, 'Use list, add, verify or remove.');
      }
      throw new CliError('usage', `Unknown domains command: ${sub}`, 'Use list, add, verify, remove or apex.');
    }

    if (cmd === 'db') {
      const l = requireLink();
      const [sub = 'list', name] = rest;
      const find = async () => {
        if (!name) throw new CliError('usage', `Usage: create db ${sub} <name>`, 'Pass the database name from `create db list`.');
        const dbs = (await call('list_databases', { project_id: l.projectId })).databases as { id: string; name: string }[];
        const db = dbs.find((d) => d.name === name);
        if (!db) throw new CliError('database_not_found', `No database named ${name}`, 'Run create db list.');
        return db;
      };
      if (sub === 'list') {
        const data = await call('list_databases', { project_id: l.projectId });
        const dbs = data.databases as { name: string; status: string; size: string; instances: number; storage_gb: number; references: Record<string, string>; backups?: string; backups_reason?: string | null }[];
        out(
          io,
          json,
          dbs.length
            ? dbs.map((d) => `${d.name} · ${d.status} · ${d.size} × ${d.instances} · ${d.storage_gb} GB · ${d.references.DATABASE_URL}${d.backups === 'unavailable' ? `\n  backups: unavailable — ${d.backups_reason ?? 'no backup store for this project'}` : ''}`).join('\n')
            : 'No databases yet: create db add',
          data,
        );
        return 0;
      }
      if (sub === 'add') {
        const extensions = typeof flags.extensions === 'string' ? flags.extensions.split(',').map((e) => e.trim()).filter(Boolean) : [];
        const data = await call('add_database', {
          project_id: l.projectId,
          name: name ?? 'db',
          ...(typeof flags.size === 'string' ? { size: flags.size } : {}),
          ...(typeof flags.storage === 'string' ? { storage_gb: Number(flags.storage) } : {}),
          ...(flags.ha === true ? { ha: true } : {}),
          ...(extensions.length ? { extensions } : {}),
        });
        const db = data.database as { name: string; status: string; references: Record<string, string> };
        out(io, json, `Database ${db.name} is ${db.status}. Use it from a service: create env set DATABASE_URL='${db.references.DATABASE_URL}' (then redeploy).`, data);
        return 0;
      }
      if (sub === 'backups') {
        const db = await find();
        const data = await call('list_database_backups', { database_id: db.id });
        const backups = data.backups as { name: string; kind: string; status: string; stoppedAt: string | null }[];
        out(io, json, backups.length ? backups.map((b) => `${b.name} · ${b.kind} · ${b.status}${b.stoppedAt ? ` · ${b.stoppedAt}` : ''}`).join('\n') : 'No backups yet.', data);
        return 0;
      }
      if (sub === 'connect') {
        const db = await find();
        if (!backend.connectDatabase || !backend.getDatabase) throw new CliError('not_available_here', 'Connect sessions are not available', 'Update the create CLI.');
        const minutes = typeof flags.minutes === 'string' ? Number(flags.minutes) : undefined;
        const session = await backend.connectDatabase(db.id, { ...(minutes ? { minutes } : {}), ...(typeof flags['client-ip'] === 'string' ? { clientIp: flags['client-ip'] } : {}) });
        let host = session.host;
        const deadline = io.now() + 3 * 60 * 1000;
        while (!host && io.now() < deadline) {
          await io.sleep(3000);
          host = (await backend.getDatabase(db.id)).publicAccess.host;
          say('… waiting for the session endpoint');
        }
        if (!host) throw new CliError('endpoint_pending', 'The database endpoint did not come up in time', 'Run create db connect again in a minute.');
        const info = { host, port: session.port, database: session.database, user: session.username, expires_at: session.expiresAt, client_cidr: session.clientCidr };
        say(`Session ${session.username} from ${session.clientCidr} until ${session.expiresAt} (TLS + SCRAM channel binding).`);
        if (json || !io.runPsql) {
          out(io, json, `psql "host=${host} port=${session.port} dbname=${session.database} user=${session.username} sslmode=require channel_binding=require options='-c role=${session.role}'" (password: PGPASSWORD, shown only to psql run by create db connect)`, info);
          return 0;
        }
        return io.runPsql({
          PGHOST: host,
          PGPORT: String(session.port),
          PGDATABASE: session.database,
          PGUSER: session.username,
          PGPASSWORD: session.password,
          PGSSLMODE: 'require',
          PGCHANNELBINDING: 'require',
          PGOPTIONS: `-c role=${session.role}`,
        });
      }
      if (sub === 'edge') {
        // E4: a person's action (dashboard or CLI), never an MCP tool — it opens the database to code outside the cluster.
        const db = await find();
        const action = rest[2];
        if (action !== 'on' && action !== 'off' && action !== 'rotate') throw new CliError('usage', 'Usage: create db edge <name> on|off|rotate', 'on opens it to edge frontends through Hyperdrive; off closes it; rotate replaces its Access token.');
        if (!backend.setDatabaseEdgeAccess) throw new CliError('not_available_here', 'Database edge access is not available', 'Update the create CLI.');
        const r = await backend.setDatabaseEdgeAccess(db.id, action === 'on' ? 'enable' : action === 'off' ? 'disable' : 'rotate');
        const d = r.database;
        const text =
          d.status === 'active'
            ? `Database ${d.name} is open to this environment's edge frontends through Hyperdrive${action === 'rotate' ? ' (Access token rotated)' : ''}. In a frontend: create env set DB='${d.reference}' --service <frontend> (a Hyperdrive binding named DB).`
            : d.status === 'off'
              ? `Database ${d.name} is closed to the edge.`
              : `Database ${d.name}: edge access ${d.status}${d.lastError ? ` (${d.lastError})` : ''}.`;
        out(io, json, text, r);
        return 0;
      }
      throw new CliError('usage', `Unknown db command: ${sub}`, 'Use list, add, backups, connect or edge.');
    }

    if (cmd === 'link') {
      if (flags.github !== true) throw new CliError('usage', 'Usage: create link --github [owner/repo]', 'Pass --github, optionally with the repository (owner/repo).');
      let projectId = link?.projectId;
      let projectName = link?.projectName ?? String(flags.project ?? projectNameFrom(dir));
      const service = String(flags.service ?? link?.service ?? 'web');
      const repository = rest[0] ?? githubOrigin(dir);
      if (!repository) throw new CliError('no_repository', 'No repository was named, and this folder has no github.com origin remote', 'Name it: create link --github owner/repo');
      if (!projectId) {
        const created = (await call('create_project', { name: projectName, ...(flags.region ? { region: flags.region } : {}) })).project as { id: string; name: string };
        projectId = created.id;
        projectName = created.name;
        writeLink(dir, { projectId, projectName, service });
        say(`Created project ${projectName} and linked this folder (.create/project.json).`);
      }
      const target = targetFrom(flags);
      const data = await call('connect_github_repo', {
        project_id: projectId,
        repository,
        service,
        ...(typeof flags.branch === 'string' ? { branch: flags.branch } : {}),
        ...(target !== 'auto' ? { target } : {}),
        ...(flags['no-deploy'] === true ? { deploy: false } : {}),
      });
      const connected = data.link as { repository: string; productionBranch: string };
      out(
        io,
        json,
        `Connected ${connected.repository} to ${projectName}: pushes to ${connected.productionBranch} deploy, pull requests get preview URLs.${data.deploying ? ` Deploying ${connected.productionBranch} now (create status).` : ''}`,
        { project_id: projectId, project: projectName, ...data },
      );
      return 0;
    }

    if (cmd === 'previews') {
      const l = requireLink();
      const data = await call('list_previews', { project_id: l.projectId, include_closed: flags.all === true });
      const previews = data.previews as { kind: string; pullRequest: number | null; branch: string; status: string; url: string | null; headSha: string; fork: boolean }[];
      const direct = (data.direct_previews as { branch: string; status: string; url: string | null; lastDeploymentId: string | null; expiresAt: string | null }[] | undefined) ?? [];
      const lines = [
        ...previews.map((p) => `${p.kind === 'pull_request' ? `PR #${p.pullRequest}` : `branch ${p.branch}`} · ${p.status}${p.url ? ` · ${p.url}` : ''} · ${p.headSha.slice(0, 7)}${p.fork ? ' · fork' : ''}`),
        ...direct.map((d) => `preview ${d.branch} · ${d.status}${d.url ? ` · ${d.url}` : ''}${d.lastDeploymentId ? ` · ${d.lastDeploymentId}` : ''}${d.expiresAt ? ` · removed ${d.expiresAt} unless redeployed` : ''}`),
      ];
      const human = lines.length ? lines.join('\n') : 'No previews yet. Run create deploy --preview, or open a pull request on the connected repository.';
      out(io, json, human, data);
      return 0;
    }

    if (cmd === 'images') {
      const [area, sub = 'list', ...hosts] = rest;
      if (area !== 'domains') throw new CliError('usage', 'Usage: create images domains [list|add|rm] [host …]', 'Only `create images domains` exists so far.');
      const l = requireLink();
      let args: Record<string, unknown>;
      if (sub === 'list' || sub === 'ls') args = { project_id: l.projectId };
      else if (sub === 'add' || sub === 'rm' || sub === 'remove') {
        if (hosts.length === 0) throw new CliError('usage', `Usage: create images domains ${sub} <host> [host …]`, 'Pass a host such as cdn.example.com or *.example.com.');
        args = { project_id: l.projectId, [sub === 'add' ? 'add' : 'remove']: hosts };
      } else throw new CliError('usage', `Unknown images domains command: ${sub}`, 'Use list, add or rm.');
      const data = await call('set_image_domains', args);
      const settings = data.image_settings as { domains: string[]; usage: { month: string; transforms: number }; quota: { monthlyTransforms: number }; plan: string };
      const human = [
        settings.domains.length ? settings.domains.join('\n') : 'No remote image domains (images of the app itself are always allowed).',
        `${settings.usage.transforms} of ${settings.quota.monthlyTransforms} image transformations used in ${settings.usage.month} (${settings.plan} plan).`,
      ].join('\n');
      out(io, json, human, data);
      return 0;
    }

    if (cmd === 'analytics') {
      const l = requireLink();
      const [sub] = rest;
      if (sub === 'on' || sub === 'off') {
        const data = await call('set_analytics', { project_id: l.projectId, enabled: sub === 'on' });
        const s = data.analytics_settings as { enabled: boolean; snippet: string; quota: { monthlyEvents: number; retentionDays: number }; usage: { month: string; events: number } };
        const human = s.enabled
          ? `Web Analytics is on for ${l.projectName}. Pages with a strict Content-Security-Policy need the tag added by hand:\n  ${s.snippet}\n${s.usage.events} of ${s.quota.monthlyEvents} events used in ${s.usage.month}; data kept ${s.quota.retentionDays} days.`
          : `Web Analytics is off for ${l.projectName}.`;
        out(io, json, human, data);
        return 0;
      }
      if (sub !== undefined && sub !== 'speed') throw new CliError('usage', `Unknown analytics command: ${sub}`, 'Use `create analytics`, `create analytics speed`, or `create analytics on|off`.');
      const granularity = flags.granularity;
      if (granularity !== undefined && granularity !== 'hour' && granularity !== 'day') throw new CliError('usage', '--granularity is hour or day', 'Pass --granularity hour or --granularity day.');
      const range = { ...(typeof flags.from === 'string' ? { from: flags.from } : {}), ...(typeof flags.to === 'string' ? { to: flags.to } : {}) };
      const data = await call('get_analytics', { project_id: l.projectId, ...range, ...(granularity && sub !== 'speed' ? { granularity } : {}), include: sub === 'speed' ? 'speed' : 'traffic' });
      if (sub === 'speed') {
        const sp = data.speed_insights as { overall: Record<string, { p75: number; rating: string; samples: number }>; routes: { route: string; metrics: Record<string, { p75: number; rating: string }> }[] };
        const fmt = (m: string, v: { p75: number; rating: string }) => `${m} ${v.p75}${m === 'CLS' ? '' : 'ms'} ${v.rating.replace('_', ' ')}`;
        const overall = Object.entries(sp.overall).map(([m, v]) => fmt(m, v));
        const lines = [overall.length ? `p75: ${overall.join(' · ')}` : 'No Web Vitals reported in this range yet.'];
        for (const r of sp.routes.slice(0, 10)) lines.push(`  ${r.route}  ${Object.entries(r.metrics).map(([m, v]) => fmt(m, v)).join(' · ')}`);
        out(io, json, lines.join('\n'), data);
        return 0;
      }
      const a = data.analytics as { enabled: boolean; from: string; to: string; totals: { pageviews: number; visitors: number }; topPages: { value: string; pageviews: number }[]; referrers: { value: string; pageviews: number }[]; countries: { value: string; pageviews: number }[]; usage: { overQuota: boolean; dropped: number; quota: number } };
      const list = (title: string, rows: { value: string; pageviews: number }[]) => (rows.length ? [`${title}:`, ...rows.slice(0, 5).map((r) => `  ${String(r.pageviews).padStart(7)}  ${r.value || '(none)'}`)] : []);
      const lines = [
        ...(a.enabled ? [] : ['Web Analytics is off for this project (create analytics on).']),
        `${a.from.slice(0, 10)} → ${a.to.slice(0, 10)}: ${a.totals.pageviews} page views, ${a.totals.visitors} visitors`,
        ...list('Top pages', a.topPages),
        ...list('Referrers', a.referrers),
        ...list('Countries', a.countries),
        ...(a.usage.overQuota ? [`Monthly quota (${a.usage.quota} events) reached: ${a.usage.dropped} events were not counted.`] : []),
      ];
      out(io, json, lines.join('\n'), data);
      return 0;
    }

    // E7: protected previews — the same MCP tools. The bypass secret is minted in the dashboard only.
    if (cmd === 'protection') {
      const l = requireLink();
      const [sub = 'show', ...args] = rest;
      type Settings = { modes: { previews: string; deployments: string; production: string }; password: { set: boolean }; bypass: { set: boolean; hint: string | null; header: string }; preflight: string; defaults: boolean };
      const summary = (s: Settings) =>
        [
          `Previews: ${s.modes.previews} · deployment addresses: ${s.modes.deployments} · production: ${s.modes.production}${s.defaults ? ' (defaults)' : ''}`,
          `Password ${s.password.set ? 'set' : 'not set'} · bypass secret ${s.bypass.set ? `set (…${s.bypass.hint}; header ${s.bypass.header})` : 'not set (create one in the dashboard)'} · CORS preflights ${s.preflight === 'pass' ? 'reach the app' : 'refused'}`,
        ].join('\n');
      if (sub === 'show' || sub === 'list' || sub === 'ls') {
        const data = await call('get_protection', { project_id: l.projectId });
        const links = data.share_links as { id: string; label: string | null; hostname: string | null; status: string; expiresAt: string; views: number; maxViews: number | null }[];
        const lines = [summary(data.protection as Settings), ...(links.length ? ['Share links:', ...links.map((k) => `  ${k.id}  ${k.status.padEnd(8)} until ${k.expiresAt.slice(0, 16)}Z  ${k.views}${k.maxViews ? `/${k.maxViews}` : ''} uses  ${k.hostname ?? 'every protected address'}${k.label ? `  (${k.label})` : ''}`)] : ['No share links.'])];
        out(io, json, lines.join('\n'), data);
        return 0;
      }
      if (sub === 'set') {
        const modes = ['off', 'account', 'password', 'link'];
        const change: Record<string, string> = {};
        for (const key of ['previews', 'deployments', 'production'] as const) {
          const v = flags[key];
          if (v === undefined) continue;
          if (typeof v !== 'string' || !modes.includes(v)) throw new CliError('usage', `--${key} is off, account, password or link`, `Pass --${key} account (for example).`);
          change[key] = v;
        }
        if (flags.preflight !== undefined) {
          if (flags.preflight !== 'refuse' && flags.preflight !== 'pass') throw new CliError('usage', '--preflight is refuse or pass', 'Pass --preflight refuse or --preflight pass.');
          change.preflight = flags.preflight;
        }
        if (Object.keys(change).length === 0) throw new CliError('usage', 'Nothing to change', 'Pass --previews, --deployments, --production or --preflight.');
        const data = await call('set_protection', { project_id: l.projectId, ...change });
        out(io, json, `${summary(data.protection as Settings)}\nEffective within a minute; everyone signed in to a protected address signs in again.`, data);
        return 0;
      }
      if (sub === 'password') {
        if (flags.remove === true) {
          const data = await call('set_protection', { project_id: l.projectId, remove_password: true });
          out(io, json, summary(data.protection as Settings), data);
          return 0;
        }
        const password = await (io.readSecret ?? ((prompt: string) => readSecretFrom(io, prompt)))('Preview password (hidden): ');
        if (!password) throw new CliError('empty_secret', 'No password was given', 'Type it at the prompt, or pipe it on stdin.');
        const data = await call('set_protection', { project_id: l.projectId, password });
        out(io, json, `Password set.\n${summary(data.protection as Settings)}\nChoose it for an address kind with: create protection set --previews password`, data);
        return 0;
      }
      if (sub === 'sign-out') {
        const data = await call('set_protection', { project_id: l.projectId, sign_everyone_out: true });
        out(io, json, 'Everyone is signed out of the protected addresses (within a minute).', data);
        return 0;
      }
      if (sub === 'share') {
        // E7 review: a share link hands a preview to someone outside the account — a signed-in person
        // creates it in the dashboard; tokens (this CLI's included) may list and revoke links only.
        throw new CliError('session_required', 'Share links are created in the Create dashboard, not with a token', 'Open the project in the dashboard → Protection → Share links. `create protection` lists links and `create protection revoke <id>` revokes one.');
      }
      if (sub === 'revoke') {
        const [linkId] = args;
        if (!linkId) throw new CliError('usage', 'Usage: create protection revoke <linkId>', 'List link ids with `create protection`.');
        const data = await call('revoke_share_link', { project_id: l.projectId, link_id: linkId });
        out(io, json, `Share link ${linkId} is revoked.`, data);
        return 0;
      }
      throw new CliError('usage', `Unknown protection command: ${sub}`, 'Use `create protection`, `set`, `password`, `sign-out`, `share` or `revoke`.');
    }

    // E7b: preview comments — the same MCP tools (list_comments, reply_comment, resolve_comment).
    if (cmd === 'comments') {
      const l = requireLink();
      const [sub = 'list', ...args] = rest;
      type Thread = { id: string; host: string; path: string; selector: string | null; status: string; comments: { author: { name: string }; body: string; createdAt: string }[] };
      if (sub === 'list' || sub === 'ls') {
        const status = flags.status;
        if (status !== undefined && status !== 'open' && status !== 'resolved' && status !== 'all') throw new CliError('usage', '--status is open, resolved or all', 'Pass --status all (for example).');
        const path = typeof flags.path === 'string' ? flags.path : undefined;
        const data = await call('list_comments', { project_id: l.projectId, ...(status ? { status } : {}), ...(path ? { path } : {}) });
        const threads = data.threads as Thread[];
        // Comment text is printed as text, one line each (control characters flattened).
        const flat = (t: string) => t.replace(/[\u0000-\u001f\u007f]+/g, ' ');
        const lines = threads.length
          ? threads.flatMap((t) => [`${t.id}  ${t.status.padEnd(8)} ${t.host}${t.path}${t.selector ? `  ${t.selector}` : ''}`, ...t.comments.map((c) => `    ${flat(c.author.name)} (${c.createdAt.slice(0, 16)}Z): ${flat(c.body)}`)])
          : [`No ${status && status !== 'all' ? `${status} ` : status === 'all' ? '' : 'open '}comments.`];
        out(io, json, lines.join('\n'), data);
        return 0;
      }
      if (sub === 'reply') {
        const [threadId, ...words] = args;
        const body = words.join(' ').trim();
        if (!threadId || !body) throw new CliError('usage', 'Usage: create comments reply <threadId> <text…>', 'List thread ids with `create comments`.');
        const data = await call('reply_comment', { project_id: l.projectId, thread_id: threadId, body });
        out(io, json, `Replied to ${threadId}.`, data);
        return 0;
      }
      if (sub === 'resolve' || sub === 'reopen') {
        const [threadId] = args;
        if (!threadId) throw new CliError('usage', `Usage: create comments ${sub} <threadId>`, 'List thread ids with `create comments`.');
        const data = await call('resolve_comment', { project_id: l.projectId, thread_id: threadId, ...(sub === 'reopen' ? { reopen: true } : {}) });
        out(io, json, `Comment thread ${threadId} is ${sub === 'reopen' ? 'open' : 'resolved'}.`, data);
        return 0;
      }
      throw new CliError('usage', `Unknown comments command: ${sub}`, 'Use `create comments`, `reply`, `resolve` or `reopen`.');
    }

    // N1: the edge firewall — the same MCP tools. Rules are ordered, first match wins.
    if (cmd === 'firewall') {
      const l = requireLink();
      const [sub = 'show', ...args] = rest;
      const text = (data: Record<string, unknown>) => (data.text as string | undefined) ?? '';
      const call = callText;
      const position = flags.position === undefined ? undefined : Number(flags.position);
      if (position !== undefined && (!Number.isInteger(position) || position < 0)) throw new CliError('usage', '--position is a whole number (0 = first)', 'Pass --position 0 to put the rule first.');
      if (sub === 'show' || sub === 'list' || sub === 'ls') {
        const data = await call('get_firewall', { project_id: l.projectId });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'block' || sub === 'allow') {
        if (args.length === 0) throw new CliError('usage', `Usage: create firewall ${sub} <ip-or-cidr>…`, `Pass one or more addresses, e.g. create firewall ${sub} 203.0.113.0/24`);
        const data = await call('add_firewall_rule', {
          project_id: l.projectId,
          name: typeof flags.name === 'string' ? flags.name : `${sub === 'block' ? 'Block' : 'Allow'} ${args.slice(0, 3).join(', ')}${args.length > 3 ? '…' : ''}`,
          action: sub === 'block' ? 'deny' : 'allow',
          match: { ips: args },
          // An allow list only helps ahead of the rules it should skip.
          ...(position !== undefined ? { position } : sub === 'allow' ? { position: 0 } : {}),
        });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'block-country') {
        if (args.length === 0) throw new CliError('usage', 'Usage: create firewall block-country <CC>…', 'Pass two-letter country codes, e.g. create firewall block-country RU T1');
        const countries = args.map((c) => c.toUpperCase());
        const data = await call('add_firewall_rule', { project_id: l.projectId, name: typeof flags.name === 'string' ? flags.name : `Block ${countries.join(', ')}`, action: 'deny', match: { countries }, ...(position !== undefined ? { position } : {}) });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'challenge') {
        if (args.length === 0) throw new CliError('usage', 'Usage: create firewall challenge <path-prefix>… [--methods POST,PUT]', 'e.g. create firewall challenge /signup --methods POST');
        const methods = typeof flags.methods === 'string' ? flags.methods.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean) : undefined;
        const data = await call('add_firewall_rule', { project_id: l.projectId, name: typeof flags.name === 'string' ? flags.name : `Challenge ${args.join(', ')}`, action: 'challenge', match: { paths: args, ...(methods ? { methods } : {}) }, ...(position !== undefined ? { position } : {}) });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'rate-limit') {
        const [path] = args;
        const limit = Number(flags.limit);
        const window = flags.window === undefined ? 60 : Number(flags.window);
        if (!path || !Number.isInteger(limit) || limit < 1) throw new CliError('usage', 'Usage: create firewall rate-limit <path-prefix> --limit <n> [--window 10|60|300|600|3600] [--methods POST] [--algorithm sliding|fixed]', 'e.g. create firewall rate-limit /login --limit 10 --window 60 --methods POST');
        if (![10, 60, 300, 600, 3600].includes(window)) throw new CliError('usage', '--window is 10, 60, 300, 600 or 3600 seconds', 'Pass --window 60.');
        if (flags.algorithm !== undefined && flags.algorithm !== 'sliding' && flags.algorithm !== 'fixed') throw new CliError('usage', '--algorithm is sliding or fixed', 'Pass --algorithm sliding.');
        const current = await call('get_firewall', { project_id: l.projectId });
        const fw = current.firewall as { generation: number; rateLimits: { id: string; name: string; enabled: boolean; paths: string[]; methods?: string[]; limit: number; windowSeconds: number; algorithm: string }[] };
        const methods = typeof flags.methods === 'string' ? flags.methods.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean) : undefined;
        const rateLimits = [
          ...fw.rateLimits.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, paths: r.paths, ...(r.methods ? { methods: r.methods } : {}), limit: r.limit, window_seconds: r.windowSeconds, algorithm: r.algorithm })),
          { name: typeof flags.name === 'string' ? flags.name : `${limit} per ${window}s on ${path}`, paths: [path], ...(methods ? { methods } : {}), limit, window_seconds: window, ...(typeof flags.algorithm === 'string' ? { algorithm: flags.algorithm } : {}) },
        ];
        const data = await call('set_firewall', { project_id: l.projectId, rate_limits: rateLimits, expected_generation: fw.generation });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'bot') {
        const [mode] = args;
        if (mode !== 'off' && mode !== 'challenge' && mode !== 'deny') throw new CliError('usage', 'Usage: create firewall bot off|challenge|deny [--threshold 1-99]', 'e.g. create firewall bot challenge --threshold 30');
        const threshold = flags.threshold === undefined ? undefined : Number(flags.threshold);
        if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > 99)) throw new CliError('usage', '--threshold is 1–99', 'Pass --threshold 30.');
        const data = await call('set_firewall', { project_id: l.projectId, bot: { mode, ...(threshold !== undefined ? { threshold } : {}) } });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'delete' || sub === 'rm') {
        const [ruleId] = args;
        if (!ruleId) throw new CliError('usage', 'Usage: create firewall delete <ruleId>', 'List rule ids with `create firewall`.');
        const data = await call('delete_firewall_rule', { project_id: l.projectId, rule_id: ruleId });
        out(io, json, text(data), data);
        return 0;
      }
      throw new CliError('usage', `Unknown firewall command: ${sub}`, 'Use `create firewall`, `block`, `allow`, `block-country`, `challenge`, `rate-limit`, `bot` or `delete`.');
    }

    // A10: Docker Compose import — preview, then (with --yes) apply exactly the previewed plan.
    if (cmd === 'compose') {
      const [sub, fileArg] = rest;
      if (sub !== 'import') throw new CliError('usage', 'Usage: create compose import [file] [--value KEY=value] [--ask-secret KEY] [--yes]', 'Run `create compose import` in the folder with compose.yaml.');
      const l = requireLink();
      const candidates = fileArg ?? (typeof flags.file === 'string' ? flags.file : null);
      const path = candidates
        ? resolve(dir, candidates)
        : ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].map((f) => join(dir, f)).find((f) => existsSync(f));
      if (!path || !existsSync(path)) throw new CliError('no_compose_file', 'No compose file found', 'Pass the file: create compose import docker-compose.yml');
      // Only a file inside the folder the CLI runs in (symlinks resolved), like deploy_directory.
      assertInside(io.cwd, path);
      const compose = readFileSync(path, 'utf8');
      const values: Record<string, string> = {};
      for (const pair of (flags.value as string[] | undefined) ?? []) {
        const eq = pair.indexOf('=');
        if (eq < 1) throw new CliError('usage', `"${pair}" is not KEY=value`, 'Write each value as --value KEY=value; secrets go through --ask-secret KEY.');
        values[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      const secrets: Record<string, string> = {};
      for (const key of (flags['ask-secret'] as string[] | undefined) ?? []) {
        if (key.includes('=')) throw new CliError('secret_in_argv', 'Secret values are never taken from the command line', `Pass only the name (--ask-secret ${key.slice(0, key.indexOf('='))}) and type the value at the prompt.`);
        const value = await (io.readSecret ?? ((prompt: string) => readSecretFrom(io, prompt)))(`Value for ${key} (hidden): `);
        if (!value) throw new CliError('empty_secret', `No value was given for ${key}`, 'Type the value at the prompt, or pipe it on stdin.');
        secrets[key] = value;
      }
      const substitutions = Object.fromEntries(((flags.container as string[] | undefined) ?? []).map((svc) => [svc, 'container']));
      const args: Record<string, unknown> = {
        project_id: l.projectId,
        compose,
        ...(Object.keys(values).length > 0 ? { values } : {}),
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        ...(Object.keys(substitutions).length > 0 ? { substitutions } : {}),
        ...(typeof flags.env === 'string' ? { environment_id: flags.env } : {}),
        ...(flags['no-deploy'] === true ? { deploy: false } : {}),
      };
      const shown = await callText('preview_compose_import', args);
      const preview = shown.preview as { planHash: string; canApply: boolean };
      if (flags.yes !== true || !preview.canApply) {
        out(io, json, `${shown.text}${preview.canApply ? '\n\nNothing was created. Run again with --yes to apply this plan.' : ''}`, shown);
        return preview.canApply ? 0 : 1;
      }
      if (!json) io.stdout.write(`${shown.text}\n\n`);
      const applied = await callText('apply_compose_import', { ...args, plan_hash: preview.planHash, idempotency_key: `cli:compose:${preview.planHash.slice(0, 40)}` });
      out(io, json, applied.text, applied);
      return 0;
    }

    // Moving a project from Vercel — the same MCP tools. The Vercel token is given in the dashboard only
    // (never through this CLI's token, which an agent could hold too); the CLI works with its connection id.
    if (cmd === 'import') {
      const [sub, arg] = rest;
      if (sub === 'status') {
        const importId = arg ?? (typeof flags.import === 'string' ? flags.import : undefined);
        if (!importId) {
          const l = requireLink();
          const shown = await callText('get_project', { project_id: l.projectId });
          out(io, json, `${shown.text}\n\nPass an import id: create import status <importId> (the apply printed it).`, shown);
          return 1;
        }
        const shown = await callText('get_import_status', { import_id: importId });
        out(io, json, shown.text, shown);
        return 0;
      }
      if (sub !== 'vercel') throw new CliError('usage', 'Usage: create import vercel --connection <id> [--from <vercel project>] [--yes] | create import status <importId>', 'Run `create help` for the options.');
      const connection = typeof flags.connection === 'string' ? flags.connection : undefined;
      if (!connection) {
        throw new CliError(
          'connection_required',
          'Connect Vercel in the Create dashboard first: open the project → Move from Vercel, and paste a Vercel access token there (Create keeps it at most 24 hours and deletes it after the import)',
          'Then run: create import vercel --connection <the connection id shown there> --from <vercel project>',
        );
      }
      if (typeof flags.from !== 'string') {
        const listed = await callText('list_vercel_projects', { connection_id: connection });
        out(io, json, `${listed.text}\n\nPick one: create import vercel --connection ${connection} --from <name or id>`, listed);
        return 0;
      }
      const l = requireLink();
      const storage: Record<string, string> = {};
      if (typeof flags.storage === 'string') {
        for (const pair of flags.storage.split(',').filter(Boolean)) {
          const [kind, choice] = pair.split('=') as [string, string | undefined];
          if (!['blob', 'postgres', 'valkey'].includes(kind) || (choice !== 'create' && choice !== 'keep')) {
            throw new CliError('usage', `"${pair}" is not a storage choice`, 'Write --storage blob=keep,postgres=create,valkey=keep (create: copy into Create; keep: keep using the old store).');
          }
          storage[kind] = choice;
        }
      }
      const secrets: Record<string, string> = {};
      for (const key of (flags['ask-secret'] as string[] | undefined) ?? []) {
        if (key.includes('=')) throw new CliError('secret_in_argv', 'Secret values are never taken from the command line', `Pass only the name (--ask-secret ${key.slice(0, key.indexOf('='))}) and type the value at the prompt.`);
        const value = await (io.readSecret ?? ((prompt: string) => readSecretFrom(io, prompt)))(`Value for ${key} (hidden): `);
        if (!value) throw new CliError('empty_secret', `No value was given for ${key}`, 'Type the value at the prompt, or pipe it on stdin.');
        secrets[key] = value;
      }
      const target = typeof flags.target === 'string' ? flags.target : undefined;
      if (target && !['auto', 'edge', 'container'].includes(target)) throw new CliError('usage', '--target is auto, edge or container', 'e.g. create import vercel … --target container');
      const args: Record<string, unknown> = {
        project_id: l.projectId,
        connection_id: connection,
        vercel_project: flags.from,
        ...(typeof flags.service === 'string' ? { service: flags.service } : {}),
        ...(target ? { target } : {}),
        ...(Object.keys(storage).length > 0 ? { storage } : {}),
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        ...(((flags.skip as string[] | undefined) ?? []).length > 0 ? { skip: flags.skip } : {}),
        ...(flags['no-domains'] === true ? { domains: false } : {}),
        ...(flags['no-crons'] === true ? { crons: false } : {}),
        ...(flags['no-github'] === true ? { github: false } : {}),
        ...(flags['no-deploy'] === true ? { deploy: false } : {}),
      };
      const shown = await callText('preview_vercel_import', args);
      const preview = shown as unknown as { planHash: string; canApply: boolean };
      if (flags.yes !== true || !preview.canApply) {
        out(io, json, `${shown.text}${preview.canApply ? '\n\nNothing was created. Run again with --yes to apply this plan.' : ''}`, shown);
        return preview.canApply ? 0 : 1;
      }
      if (!json) io.stdout.write(`${shown.text}\n\n`);
      const applied = await callText('apply_vercel_import', { ...args, plan_hash: preview.planHash, idempotency_key: `cli:vercel:${preview.planHash.slice(0, 40)}` });
      out(io, json, applied.text, applied);
      return 0;
    }

    // A11: replicas, the autoscaler and sleep-on-idle of the linked service (the same MCP tools).
    if (cmd === 'scale') {
      const l = requireLink();
      const project = await backend.getProject(l.projectId);
      const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
      if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)}`, 'Pass --service <name>, or deploy first.');
      const change: Record<string, unknown> = {};
      if (flags.replicas !== undefined) {
        const n = Number(flags.replicas);
        if (!Number.isInteger(n) || n < 0 || n > 20) throw new CliError('usage', '--replicas is 0–20', 'e.g. create scale --replicas 2');
        change.replicas = n;
      }
      if (flags.max !== undefined) {
        const n = flags.max === 'off' ? null : Number(flags.max);
        if (n !== null && (!Number.isInteger(n) || n < 1 || n > 20)) throw new CliError('usage', '--max is 1–20, or off', 'e.g. create scale --max 5');
        change.max_replicas = n;
      }
      if (flags.cpu !== undefined) {
        const n = Number(flags.cpu);
        if (!Number.isInteger(n) || n < 20 || n > 95) throw new CliError('usage', '--cpu is 20–95 (percent of the size’s CPU)', 'e.g. create scale --max 5 --cpu 60');
        change.target_cpu_percent = n;
      }
      if (flags.sleep !== undefined) {
        const v = String(flags.sleep);
        const m = /^(\d+)(m|h)$/.exec(v);
        const minutes = v === 'off' ? null : m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : NaN;
        if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) throw new CliError('usage', '--sleep is 5m–24h, or off', 'e.g. create scale --sleep 15m');
        change.sleep_after_minutes = minutes;
      }
      if (typeof flags.size === 'string') change.size = flags.size;
      if (Object.keys(change).length === 0) {
        const data = await callText('get_scaling', { service_id: svc.id });
        out(io, json, data.text, data);
        return 0;
      }
      const data = await callText('scale_service', { service_id: svc.id, ...change, redeploy: flags.now === true });
      out(io, json, data.text, data);
      return 0;
    }

    // A11 "wake now": wake the linked (sleeping) web service without sending it a request.
    if (cmd === 'wake') {
      const l = requireLink();
      const project = await backend.getProject(l.projectId);
      const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
      if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)}`, 'Pass --service <name>, or deploy first.');
      const data = await callText('wake_service', { service_id: svc.id });
      out(io, json, data.text, data);
      return 0;
    }

    // N1: static egress IP for the project's container services.
    if (cmd === 'egress') {
      const l = requireLink();
      const [sub = 'show'] = rest;
      const call = callText;
      if (sub !== 'show' && sub !== 'on' && sub !== 'off') throw new CliError('usage', `Unknown egress command: ${sub}`, 'Use `create egress`, `create egress on` or `create egress off`.');
      const data = sub === 'show' ? await call('get_static_egress', { project_id: l.projectId }) : await call('set_static_egress', { project_id: l.projectId, enabled: sub === 'on' });
      out(io, json, (data.text as string | undefined) ?? '', data);
      return 0;
    }

    // A12: the project's review notice — the same MCP tool. Appeals are a person's, in the dashboard.
    if (cmd === 'review') {
      const l = requireLink();
      if (rest.length > 0) throw new CliError('usage', `Unknown review command: ${rest[0]}`, 'Use `create review`; appeal from the dashboard (Project › Review).');
      const data = await callText('get_review_notice', { project_id: l.projectId });
      out(io, json, (data.text as string | undefined) ?? '', data);
      return 0;
    }

    // D1: registered domains (read only) — the same MCP tools; the account's hosting access decides, not the project link.
    if (cmd === 'domains') {
      const accountId = typeof flags.account === 'string' ? flags.account : undefined;
      const [name] = rest;
      const data = name ? await callText('get_domain', { name, ...(accountId ? { account_id: accountId } : {}) }) : await callText('list_domains', accountId ? { account_id: accountId } : {});
      out(io, json, (data.text as string | undefined) ?? '', data);
      return 0;
    }

    // E3: edge settings — the same MCP tools (preview TTL, old production addresses).
    if (cmd === 'edge-settings') {
      const l = requireLink();
      const [sub = 'show'] = rest;
      if (sub === 'show') {
        const data = await callText('get_edge_settings', { project_id: l.projectId });
        out(io, json, (data.text as string | undefined) ?? '', data);
        return 0;
      }
      if (sub !== 'set') throw new CliError('usage', `Unknown edge-settings command: ${sub}`, 'Use `create edge-settings` or `create edge-settings set [--ttl days|default] [--old-addresses on|off]`.');
      const change: Record<string, unknown> = {};
      if (flags.ttl !== undefined) {
        const t = String(flags.ttl);
        if (t === 'default') change.preview_ttl_days = null;
        else if (/^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 90) change.preview_ttl_days = Number(t);
        else throw new CliError('usage', '--ttl is a number of days from 1 to 90, or default', 'Pass --ttl 14 (for example) or --ttl default.');
      }
      if (flags['old-addresses'] !== undefined) {
        const v = flags['old-addresses'];
        if (v !== 'on' && v !== 'off') throw new CliError('usage', '--old-addresses is on or off', 'Pass --old-addresses on or --old-addresses off.');
        change.old_addresses_open = v === 'on';
      }
      if (Object.keys(change).length === 0) throw new CliError('usage', 'Nothing to change', 'Pass --ttl, --old-addresses, or both.');
      const data = await callText('set_edge_settings', { project_id: l.projectId, ...change });
      out(io, json, (data.text as string | undefined) ?? '', data);
      return 0;
    }

    // A7 alerting — the same MCP tools (get_alerts, add/update/delete_alert_rule, add/delete_alert_channel, send_test_alert).
    if (cmd === 'alerts') {
      const l = requireLink();
      const [sub = 'show', ...args] = rest;
      const print = (data: Record<string, unknown> & { text: string }) => {
        out(io, json, data.text, data);
        return 0;
      };
      if (sub === 'show') return print(await callText('get_alerts', { project_id: l.projectId }));
      if (sub === 'add') {
        const [signal] = args;
        if (!signal) throw new CliError('usage', 'Name a signal', 'For example: `create alerts add error_rate --threshold 5 --window 5`.');
        const input: Record<string, unknown> = { project_id: l.projectId, signal };
        const num = (name: string, field: string) => {
          if (flags[name] === undefined) return;
          const v = Number(flags[name]);
          if (!Number.isFinite(v)) throw new CliError('usage', `--${name} is a number`, `Pass --${name} <number>.`);
          input[field] = v;
        };
        num('threshold', 'threshold');
        num('window', 'window_minutes');
        num('renotify', 'renotify_minutes');
        if (typeof flags.name === 'string') input.name = flags.name;
        if (typeof flags.channels === 'string') input.channel_ids = flags.channels.split(',').map((c) => c.trim()).filter(Boolean);
        if (typeof flags.service === 'string') {
          const project = await backend.getProject(l.projectId);
          const svc = project.services.find((x) => x.name === flags.service);
          if (!svc) throw new CliError('service_not_found', `No service named ${flags.service}`, 'Pass --service <name> of a service in this project.');
          input.service_id = svc.id;
        }
        if (typeof flags.quiet === 'string') {
          const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})@(.+)$/.exec(flags.quiet);
          if (!m) throw new CliError('usage', '--quiet is HH:MM-HH:MM@Time/Zone', 'For example: --quiet 22:00-07:00@Europe/Berlin');
          input.quiet_hours = { start: m[1], end: m[2], time_zone: m[3] };
        }
        return print(await callText('add_alert_rule', input));
      }
      if (sub === 'on' || sub === 'off' || sub === 'rm') {
        const [ruleId] = args;
        if (!ruleId) throw new CliError('usage', 'Name the rule', `Use \`create alerts ${sub} <ruleId>\` (ids are in \`create alerts\`).`);
        return print(sub === 'rm' ? await callText('delete_alert_rule', { rule_id: ruleId }) : await callText('update_alert_rule', { rule_id: ruleId, enabled: sub === 'on' }));
      }
      if (sub === 'channel') {
        const [action, a1] = args;
        if (action === 'add') {
          const kind = a1;
          const name = typeof flags.name === 'string' ? flags.name : kind === 'email' ? 'Email' : kind === 'webhook' ? 'Webhook' : 'Chat';
          if (kind === 'email') {
            const roles = typeof flags.roles === 'string' ? flags.roles.split(',').map((r) => r.trim()).filter(Boolean) : undefined;
            return print(await callText('add_alert_channel', { project_id: l.projectId, kind, name, ...(roles ? { roles } : {}) }));
          }
          if (kind === 'webhook' || kind === 'slack') {
            // The URL is a credential (Slack/Discord) or may carry one in its path: read it like a secret, never from argv.
            if (args[2]) throw new CliError('usage', 'Do not put the URL on the command line', `Run \`create alerts channel add ${kind}\` and paste the URL at the prompt, or pipe it on stdin.`);
            const url = (await (io.readSecret ?? ((prompt: string) => readSecretFrom(io, prompt)))(`${kind === 'slack' ? 'Slack or Discord incoming-webhook' : 'Webhook'} URL (hidden): `)).trim();
            if (!url) throw new CliError('empty_secret', 'No URL was given', 'Paste it at the prompt, or pipe it on stdin.');
            return print(await callText('add_alert_channel', { project_id: l.projectId, kind, name, url }));
          }
          throw new CliError('usage', 'Channel kinds: email, webhook, slack', 'Use `create alerts channel add email|webhook|slack` (URLs are read from a prompt or stdin).');
        }
        if ((action === 'rm' || action === 'test') && a1) {
          return print(await callText(action === 'rm' ? 'delete_alert_channel' : 'send_test_alert', { channel_id: a1 }));
        }
        throw new CliError('usage', `Unknown alerts channel command: ${action ?? ''}`, 'Use `create alerts channel add|rm|test …`.');
      }
      throw new CliError('usage', `Unknown alerts command: ${sub}`, 'Use `create alerts`, `create alerts add <signal>`, `create alerts on|off|rm <ruleId>` or `create alerts channel …`.');
    }

    // E4: private networking — the same MCP tools.
    if (cmd === 'private') {
      const l = requireLink();
      const [sub = 'show'] = rest;
      if (sub === 'show') {
        const data = await callText('get_private_networking', { project_id: l.projectId });
        out(io, json, data.text, data);
        return 0;
      }
      if (sub === 'on' || sub === 'off') {
        const project = await backend.getProject(l.projectId);
        const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
        if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)}`, 'Pass --service <name>, or deploy first.');
        const data = await callText('set_service_visibility', { service_id: svc.id, visibility: sub === 'on' ? 'project' : 'public' });
        out(io, json, data.text, data);
        return 0;
      }
      if (sub === 'rotate-keys') {
        const data = await callText('rotate_private_keys', { project_id: l.projectId, emergency: flags.emergency === true });
        out(io, json, data.text, data);
        return 0;
      }
      throw new CliError('usage', `Unknown private command: ${sub}`, 'Use `create private`, `create private on|off` or `create private rotate-keys`.');
    }

    // X1: sandboxes — the same MCP tools. `sandbox exec … -- cmd args` runs argv as is and exits with its code.
    if (cmd === 'sandbox' || cmd === 'sandboxes') {
      const [sub = 'list', ...args] = rest;
      const text = (data: Record<string, unknown>) => (data.text as string | undefined) ?? '';
      const num = (name: string): number | undefined => {
        if (flags[name] === undefined) return undefined;
        const n = Number(flags[name]);
        if (!Number.isInteger(n) || n < 0) throw new CliError('usage', `--${name} is a whole number`, `Pass --${name} 600.`);
        return n;
      };
      const needId = (usage: string): string => {
        const [id] = args;
        if (!id || !/^sb[a-z0-9]{20}$/.test(id)) throw new CliError('usage', `Usage: create sandbox ${usage}`, 'List sandbox ids with `create sandbox`.');
        return id;
      };
      if (sub === 'list' || sub === 'ls-all' || sub === 'show') {
        const data = await callText('list_sandboxes', { project_id: requireLink().projectId, include_ended: flags.all === true });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'create') {
        const port = num('port');
        const data = await callText('create_sandbox', {
          project_id: requireLink().projectId,
          ...(typeof flags.image === 'string' ? { image: flags.image } : {}),
          ...(typeof flags.size === 'string' ? { size: flags.size } : {}),
          ...(num('lifetime') !== undefined ? { lifetime_seconds: num('lifetime') } : {}),
          ...(num('idle') !== undefined ? { idle_timeout_seconds: num('idle') } : {}),
          ...(flags.internet === true ? { internet: true } : {}),
          ...(port !== undefined ? { ports: [port] } : {}),
          ...(typeof flags.snapshot === 'string' ? { snapshot_id: flags.snapshot } : {}),
          ...(typeof flags.name === 'string' ? { name: flags.name } : {}),
        });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'exec' || sub === 'run') {
        const id = needId('exec <id> -- <command> [args…]');
        const dashDash = argv.indexOf('--');
        const command = dashDash >= 0 ? argv.slice(dashDash + 1) : args.slice(1);
        if (command.length === 0) throw new CliError('usage', 'Usage: create sandbox exec <id> -- <command> [args…]', 'e.g. create sandbox exec sb… -- npm test');
        const timeout = num('timeout');
        const data = await callText('run_in_sandbox', { sandbox_id: id, command, ...(typeof flags.cwd === 'string' ? { cwd: flags.cwd } : {}), ...(timeout !== undefined ? { timeout_seconds: timeout } : {}) });
        const r = data.result as { done: boolean; stdout: string; stderr: string; command: { exitCode: number | null; timedOut: boolean; error: string | null } };
        if (json) {
          io.stdout.write(`${JSON.stringify(data)}\n`);
        } else {
          io.stdout.write(r.stdout);
          io.stderr.write(r.stderr);
        }
        if (!r.done) return 124;
        if (r.command.timedOut) return 124;
        return r.command.exitCode ?? 1;
      }
      if (sub === 'write') {
        const id = needId('write <id> <path> --from <local-file>');
        const path = args[1];
        if (!path || typeof flags.from !== 'string') throw new CliError('usage', 'Usage: create sandbox write <id> <path> --from <local-file>', 'e.g. create sandbox write sb… main.py --from ./main.py');
        const bytes = readFileSync(flags.from);
        const data = await callText('write_sandbox_file', { sandbox_id: id, path, content_base64: bytes.toString('base64') });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'read' || sub === 'cat') {
        const id = needId('read <id> <path>');
        const path = args[1];
        if (!path) throw new CliError('usage', 'Usage: create sandbox read <id> <path>', 'e.g. create sandbox read sb… output.txt');
        const data = await callText('read_sandbox_file', { sandbox_id: id, path });
        const file = data.file as { contentBase64: string };
        if (json) io.stdout.write(`${JSON.stringify(data)}\n`);
        else io.stdout.write(Buffer.from(file.contentBase64, 'base64'));
        return 0;
      }
      if (sub === 'ls') {
        const id = needId('ls <id> [path]');
        const data = await callText('list_sandbox_files', { sandbox_id: id, ...(args[1] ? { path: args[1] } : {}) });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'expose') {
        const id = needId('expose <id> <port> [--ttl seconds]');
        const port = Number(args[1]);
        if (!Number.isInteger(port)) throw new CliError('usage', 'Usage: create sandbox expose <id> <port> [--ttl seconds]', 'e.g. create sandbox expose sb… 3000');
        const ttl = num('ttl');
        const data = await callText('expose_sandbox_port', { sandbox_id: id, port, ...(ttl !== undefined ? { ttl_seconds: ttl } : {}) });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'snapshot') {
        const id = needId('snapshot <id> [--name "…"]');
        const data = await callText('snapshot_sandbox', { sandbox_id: id, ...(typeof flags.name === 'string' ? { name: flags.name } : {}) });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'snapshots') {
        const data = await callText('list_sandbox_snapshots', { project_id: requireLink().projectId });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'delete-snapshot') {
        const [snapshotId] = args;
        if (!snapshotId) throw new CliError('usage', 'Usage: create sandbox delete-snapshot <snapshotId>', 'List snapshot ids with `create sandbox snapshots`.');
        const data = await callText('delete_sandbox_snapshot', { snapshot_id: snapshotId });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'stop') {
        const data = await callText('stop_sandbox', { sandbox_id: needId('stop <id>') });
        out(io, json, text(data), data);
        return 0;
      }
      if (sub === 'extend') {
        const id = needId('extend <id> --minutes <n>');
        const minutes = Number(flags.minutes);
        if (!Number.isInteger(minutes) || minutes < 1) throw new CliError('usage', 'Usage: create sandbox extend <id> --minutes <n>', 'Minutes to add, a whole number (the plan caps a sandbox at 45 minutes on Hobby, 5 hours on Pro from its creation).');
        const data = await callText('extend_sandbox', { sandbox_id: id, add_seconds: minutes * 60 });
        out(io, json, text(data), data);
        return 0;
      }
      throw new CliError('usage', `Unknown sandbox command: ${sub}`, 'Use `create sandbox`, `create`, `exec`, `write`, `read`, `ls`, `expose`, `snapshot`, `snapshots`, `delete-snapshot`, `extend` or `stop`.');
    }

    // S1: Create Blob — the same MCP tools, plus a direct upload through a short-lived upload URL.
    if (cmd === 'blob') {
      const [sub = 'stores', ...args] = rest;
      const l = requireLink();
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      type StoreRow = { id: string; name: string; access: string; variableName: string; baseUrl: string; bytesUsed: number; objectCount: number; quota: { storageBytes: number } };
      const pickStore = async (): Promise<StoreRow> => {
        const stores = (await call('list_blob_stores', { project_id: l.projectId })).stores as StoreRow[];
        const wanted = typeof flags.store === 'string' ? flags.store : null;
        const found = wanted ? stores.find((st) => st.id === wanted || st.name === wanted) : stores.length === 1 ? stores[0] : undefined;
        if (!found) {
          if (stores.length === 0) throw new CliError('no_blob_store', 'This project has no blob store', 'Create one: create blob create uploads');
          throw new CliError('store_required', wanted ? `No blob store named ${wanted}` : 'This project has more than one blob store', `Pass --store with one of: ${stores.map((st) => st.name).join(', ')}.`);
        }
        return found;
      };
      if (sub === 'stores' || sub === 'list') {
        const data = await call('list_blob_stores', { project_id: l.projectId });
        const stores = data.stores as StoreRow[];
        out(io, json, stores.length ? stores.map((st) => `${st.name}\t${st.id}\t${st.access}\t${st.objectCount} blobs\t${mb(st.bytesUsed)} of ${mb(st.quota.storageBytes)}\t${st.variableName}\t${st.baseUrl}`).join('\n') : 'No blob stores yet. Create one: create blob create uploads', data);
        return 0;
      }
      if (sub === 'create') {
        const name = args[0];
        if (!name) throw new CliError('usage', 'Usage: create blob create <name> [--private]', 'Pass a store name such as uploads.');
        const data = await call('create_blob_store', { project_id: l.projectId, name, access: flags.private === true ? 'private' : 'public', inline_images: flags['inline-images'] === true, ...(typeof flags.variable === 'string' ? { variable_name: flags.variable } : {}) });
        const st = data.store as StoreRow;
        out(io, json, `Created ${st.access} blob store ${st.name} (${st.id}). Token: ${st.variableName} in ${String(data.environments)} environment(s); redeploy containers to pick it up.${st.access === 'public' ? ` URLs: ${st.baseUrl}/<pathname>` : ''}`, data);
        return 0;
      }
      if (sub === 'ls') {
        const st = await pickStore();
        const data = await call('list_blobs', { store_id: st.id, ...(args[0] ? { prefix: args[0] } : {}), ...(typeof flags.cursor === 'string' ? { cursor: flags.cursor } : {}), limit: 1000 });
        const blobs = data.blobs as { pathname: string; size: number; url: string }[];
        const lines = blobs.map((b) => `${b.pathname}\t${b.size}\t${b.url}`);
        if (data.hasMore) lines.push(`… more: create blob ls ${args[0] ?? ''} --cursor ${String(data.cursor)}`.replace('  ', ' '));
        out(io, json, lines.length ? lines.join('\n') : 'No blobs.', data);
        return 0;
      }
      if (sub === 'put') {
        const file = args[0];
        if (!file) throw new CliError('usage', 'Usage: create blob put <file> [pathname]', 'Pass the file to upload.');
        const path = resolve(io.cwd, file);
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          throw new CliError('file_not_found', `${file} does not exist or cannot be read`, 'Pass a path to a readable file.');
        }
        if (flags.multipart === true || size > BLOB_PUT_SINGLE_MAX) {
          const st = await pickStore();
          const done = await putMultipartFile(backend, io, st.id, path, size, { pathname: args[1] ?? basename(path), contentType: typeof flags['content-type'] === 'string' ? flags['content-type'] : undefined, addRandomSuffix: flags['random-suffix'] === true, allowOverwrite: flags.overwrite === true });
          out(io, json, `Uploaded ${String(done.pathname)} (${size} bytes, in parts): ${String(done.url)}`, done);
          return 0;
        }
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(path);
        } catch {
          throw new CliError('file_not_found', `${file} does not exist or cannot be read`, 'Pass a path to a readable file.');
        }
        const st = await pickStore();
        if (!backend.createBlobUploadUrl) throw new CliError('not_available_yet', 'Uploads are not available', 'Update the create CLI.');
        const pathname = args[1] ?? basename(path);
        let ticket;
        try {
          ticket = await backend.createBlobUploadUrl(st.id, { pathname, maxBytes: Math.max(1, bytes.byteLength), addRandomSuffix: flags['random-suffix'] === true, allowOverwrite: flags.overwrite === true });
        } catch (error) {
          if (error instanceof AgentError) throw new CliError(error.code, error.message, error.fix);
          throw error;
        }
        const type = typeof flags['content-type'] === 'string' ? flags['content-type'] : 'application/octet-stream';
        const res = await io.fetchImpl(ticket.uploadUrl, { method: 'PUT', headers: { 'content-type': type }, body: bytes as unknown as NonNullable<RequestInit['body']> });
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // not JSON
        }
        if (!res.ok) throw new CliError(String(body.error ?? `http_${res.status}`), String(body.message ?? `Upload failed (${res.status})`), String(body.fix ?? 'Try again.'));
        out(io, json, `Uploaded ${String(body.pathname)} (${bytes.byteLength} bytes): ${String(body.url)}`, body);
        return 0;
      }
      if (sub === 'rm' || sub === 'remove') {
        if (args.length === 0) throw new CliError('usage', 'Usage: create blob rm <pathname> [pathname …]', 'Pass the pathnames to delete (create blob ls lists them).');
        const st = await pickStore();
        const data = await call('delete_blobs', { store_id: st.id, pathnames: args });
        const nf = data.notFound as string[];
        out(io, json, `Deleted ${(data.deleted as string[]).length} blob(s).${nf.length ? ` Not found: ${nf.join(', ')}` : ''}`, data);
        return 0;
      }
      if (sub === 'rotate') {
        const st = await pickStore();
        const data = await call('rotate_blob_token', { store_id: st.id });
        out(io, json, `Rotated ${st.name}'s token in ${String(data.environments)} environment(s). Redeploy container services to pick it up.`, data);
        return 0;
      }
      throw new CliError('usage', `Unknown blob command: ${sub}`, 'Use stores, create, ls, put, rm or rotate.');
    }

    // X3: queues and durable workflows, through the same tools an AI connection uses.
    if (cmd === 'queues' || cmd === 'queue' || cmd === 'workflows' || cmd === 'workflow') {
      const l = requireLink();
      const isWorkflowCmd = cmd.startsWith('workflow');
      const [sub = 'list', ...args] = rest;
      type Row = { id: string; kind: 'queue' | 'workflow'; name: string; delivery: string; paused: boolean; stats: Record<string, number>; lastError: string | null; references: { url: string; token: string; signingSecret: string } };
      const listAll = async (): Promise<Row[]> => {
        const data = await call('list_queues', { project_id: l.projectId });
        return [...((data.queues as Row[]) ?? []), ...((data.workflows as Row[]) ?? [])];
      };
      const pick = async (ref: string | undefined, kind?: 'queue' | 'workflow'): Promise<Row> => {
        if (!ref) throw new CliError('usage', `Name the ${kind ?? 'queue or workflow'}`, `List them with \`create queues\`.`);
        const all = (await listAll()).filter((r) => !kind || r.kind === kind);
        const found = all.filter((r) => r.id === ref || r.name === ref);
        if (found.length === 1) return found[0]!;
        if (found.length > 1) throw new CliError('ambiguous', `Both a queue and a workflow are named ${ref}`, 'Pass its id instead.');
        throw new CliError('not_found', `No ${kind ?? 'queue or workflow'} named ${ref}`, `One of: ${all.map((r) => r.name).join(', ') || '(none yet)'}.`);
      };
      const payloadOf = (text: string | undefined): unknown => {
        if (text === undefined) return undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      };
      const stat = (st: Record<string, number>) => Object.entries(st).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty';
      if (sub === 'list' || sub === 'ls') {
        const data = await call('list_queues', { project_id: l.projectId });
        const rows = [...((data.queues as Row[]) ?? []), ...((data.workflows as Row[]) ?? [])].filter((r) => !isWorkflowCmd || r.kind === 'workflow');
        out(io, json, rows.length ? rows.map((r) => `${r.kind}\t${r.name}\t${r.id}\t${r.kind === 'queue' ? r.delivery : 'push'}${r.paused ? ' (paused)' : ''}\t${stat(r.stats)}${r.lastError ? `\tlast error ${r.lastError}` : ''}`).join('\n') : 'No queues or workflows yet. Create one: create queues create emails', data);
        return 0;
      }
      if (sub === 'create') {
        const name = args[0];
        if (!name) throw new CliError('usage', `Usage: create ${isWorkflowCmd ? 'workflows' : 'queues'} create <name> [--service <id> --path /api/…]`, 'Pass a name such as emails.');
        const service = typeof flags.service === 'string' ? flags.service : undefined;
        const path = typeof flags.path === 'string' ? flags.path : undefined;
        if ((service && !path) || (!service && path)) throw new CliError('usage', 'Pass --service and --path together', 'Both name the push target: a service of the environment and a path on it.');
        const common = {
          project_id: l.projectId,
          name,
          ...(typeof flags.env === 'string' ? { environment_id: flags.env } : {}),
          ...(typeof flags['max-attempts'] === 'string' ? { max_attempts: Number(flags['max-attempts']) } : {}),
        };
        const data = isWorkflowCmd
          ? await call('create_workflow', { ...common, target_service_id: service, target_path: path })
          : await call('create_queue', { ...common, ...(service ? { target_service_id: service, target_path: path } : {}) });
        const row = (data.queue ?? data.workflow) as Row;
        out(io, json, `Created ${row.kind} ${row.name} (${row.id}). Reference it from your variables: ${row.references.url}, ${row.references.token}${row.kind === 'workflow' || row.delivery === 'push' ? `, ${row.references.signingSecret}` : ''}.`, data);
        return 0;
      }
      if (sub === 'send') {
        const q = await pick(args[0], 'queue');
        if (args[1] === undefined) throw new CliError('usage', 'Usage: create queues send <queue> <json>', 'Pass the message body, e.g. \'{"orderId":7}\'.');
        const delay = typeof flags.delay === 'string' ? parseDurationFlag(flags.delay) : undefined;
        const data = await call('send_queue_message', { queue_id: q.id, messages: [{ body: payloadOf(args[1]), ...(delay !== undefined ? { delay_seconds: delay } : {}), ...(typeof flags.dedupe === 'string' ? { dedupe_key: flags.dedupe } : {}) }] });
        const m = (data.messages as { id: string; deduplicated: boolean }[])[0]!;
        out(io, json, m.deduplicated ? `Dropped: a message with this dedupe key is still stored (${m.id}).` : `Sent ${m.id} to ${q.name}.`, data);
        return 0;
      }
      if (sub === 'dead') {
        const q = await pick(args[0], 'queue');
        const data = await call('list_dead_letters', { queue_id: q.id });
        const rows = data.deadLetters as { id: string; attempts: number; lastError: string | null; deadAt: string }[];
        out(io, json, rows.length ? rows.map((d) => `${d.id}\t${d.attempts} attempts\t${d.lastError ?? ''}\t${d.deadAt}`).join('\n') : 'No dead letters.', data);
        return 0;
      }
      if (sub === 'redrive') {
        const q = await pick(args[0], 'queue');
        const data = await call('redrive_dead_letters', { queue_id: q.id });
        out(io, json, `Put ${String(data.count)} message(s) back on ${q.name}.`, data);
        return 0;
      }
      if (sub === 'rotate') {
        const r = await pick(args[0], isWorkflowCmd ? 'workflow' : undefined);
        const data = await call('rotate_queue_secrets', { kind: r.kind, id: r.id, immediate: flags.immediate === true });
        out(io, json, data.graceEndsAt ? `Rotated ${r.name}. The old token and signing secret work until ${String(data.graceEndsAt)}; redeploy containers before then.` : `Rotated ${r.name}. The old token stopped working now; redeploy every service that references it.`, data);
        return 0;
      }
      if (sub === 'schedule') {
        const r = await pick(args[0], isWorkflowCmd ? 'workflow' : undefined);
        if (!args[1]) throw new CliError('usage', 'Usage: create queues schedule <queue|workflow> "<cron>" [json]', 'Pass five cron fields in UTC, e.g. "0 9 * * 1".');
        const data = await call('add_queue_schedule', { kind: r.kind, id: r.id, cron: args[1], ...(args[2] !== undefined ? { payload: payloadOf(args[2]) } : {}) });
        const sch = data.schedule as { cron: string; nextRunAt: string };
        out(io, json, `Scheduled ${r.name} at "${sch.cron}" (UTC); next ${sch.nextRunAt}.`, data);
        return 0;
      }
      if (sub === 'rm' || sub === 'delete') {
        const r = await pick(args[0], isWorkflowCmd ? 'workflow' : undefined);
        if (typeof flags.confirm !== 'string') throw new CliError('usage', `Deleting ${r.name} removes everything it holds`, `Confirm with --confirm ${r.name}.`);
        const data = await call('delete_queue', { kind: r.kind, id: r.id, confirm: flags.confirm });
        out(io, json, `Deleted ${r.kind} ${r.name}.`, data);
        return 0;
      }
      if (sub === 'start') {
        const w = await pick(args[0], 'workflow');
        const data = await call('start_workflow_run', { workflow_id: w.id, ...(args[1] !== undefined ? { input: payloadOf(args[1]) } : {}), ...(typeof flags.key === 'string' ? { idempotency_key: flags.key } : {}) });
        const run = data.run as { id: string; status: string };
        out(io, json, data.created ? `Started run ${run.id}.` : `Run ${run.id} already exists for this key (${run.status}).`, data);
        return 0;
      }
      if (sub === 'runs') {
        const w = await pick(args[0], 'workflow');
        const data = await call('list_workflow_runs', { workflow_id: w.id, ...(typeof flags.status === 'string' ? { status: flags.status } : {}) });
        const runs = data.runs as { id: string; status: string; stepCount: number; failureCode: string | null; createdAt: string }[];
        out(io, json, runs.length ? runs.map((r) => `${r.id}\t${r.status}\t${r.stepCount} steps${r.failureCode ? `\t${r.failureCode}` : ''}\t${r.createdAt}`).join('\n') : 'No runs.', data);
        return 0;
      }
      if (sub === 'run') {
        const w = await pick(args[0], 'workflow');
        if (!args[1]) throw new CliError('usage', 'Usage: create workflows run <workflow> <runId>', 'List run ids with `create workflows runs <workflow>`.');
        const data = await call('get_workflow_run', { workflow_id: w.id, run_id: args[1] });
        const run = data.run as { id: string; status: string; failureCode: string | null; steps?: { seq: number; key: string; kind: string; attempts: number }[] };
        out(io, json, [`${run.id}: ${run.status}${run.failureCode ? ` (${run.failureCode})` : ''}`, ...(run.steps ?? []).map((st) => `  ${st.seq}. ${st.key} (${st.kind}, ${st.attempts} attempt(s))`)].join('\n'), data);
        return 0;
      }
      if (sub === 'cancel' || sub === 'retry') {
        const w = await pick(args[0], 'workflow');
        if (!args[1]) throw new CliError('usage', `Usage: create workflows ${sub} <workflow> <runId>`, 'List run ids with `create workflows runs <workflow>`.');
        const data = await call('cancel_workflow_run', { workflow_id: w.id, run_id: args[1], action: sub });
        out(io, json, `Run ${args[1]} is ${String((data.run as { status: string }).status)}.`, data);
        return 0;
      }
      throw new CliError('usage', `Unknown ${isWorkflowCmd ? 'workflows' : 'queues'} command: ${sub}`, 'Use list, create, send, dead, redrive, rotate, schedule, rm, start, runs, run, cancel or retry.');
    }

    // X2: the AI Gateway, through the same tools an AI connection uses.
    if (cmd === 'ai') {
      const l = requireLink();
      const [sub = 'status', ...args] = rest;
      type Gateway = {
        configured: boolean;
        enabled: boolean;
        url: string;
        references: { url: string; token: string };
        settings: { monthlyLimitMicrousd: number };
        models: { id: string; allowed: boolean; keySource: string | null; billedPrice: { input: number; output: number }; listPrice: { input: number; output: number }; costIndex?: number; tier?: string; tools?: boolean; reasoning?: string; contextTokens?: number; blockedBy?: string | null; kind?: 'chat' | 'embedding'; vision?: boolean }[];
        aliases?: { id: string; resolvesTo: string | null }[];
        policyNeedsAttention?: boolean;
        tokens: { id: string; name: string; kind: string; hint: string; graceEndsAt: string | null }[];
        providerKeys: { provider: string; hint: string }[];
        usage: { billedMicrousd: number; reservedMicrousd: number; limitMicrousd: number };
      };
      const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
      const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      if (sub === 'status' || sub === 'show') {
        const data = await call('get_ai_gateway', { project_id: l.projectId });
        const g = data.gateway as Gateway;
        out(
          io,
          json,
          g.configured
            ? [
                `AI Gateway ${g.enabled ? 'on' : 'off'} — ${g.url}`,
                `Wire it: OPENAI_BASE_URL = ${g.references.url}, OPENAI_API_KEY = ${g.references.token}`,
                `This month: ${usd(g.usage.billedMicrousd)} of ${usd(g.usage.limitMicrousd)}${g.usage.reservedMicrousd ? ` (${usd(g.usage.reservedMicrousd)} in flight)` : ''}`,
                `Tokens: ${g.tokens.map((t) => `${t.name} ${t.hint}${t.kind === 'reference' ? ' (reference)' : ''}${t.graceEndsAt ? ` until ${t.graceEndsAt}` : ''}`).join(', ')}`,
                `Own keys: ${g.providerKeys.map((k) => `${k.provider} ${k.hint}`).join(', ') || 'none'}`,
                ...(g.policyNeedsAttention ? ['Attention: the model policy is no longer fully valid and is applied as strictly as possible; review it with `create ai policy` and save it again.'] : []),
              ].join('\n')
            : 'The AI Gateway is off for this project. Turn it on: create ai enable',
          data,
        );
        return 0;
      }
      if (sub === 'enable' || sub === 'disable' || sub === 'limit') {
        const input: Record<string, unknown> = { project_id: l.projectId };
        if (sub !== 'limit') input.enabled = sub === 'enable';
        const models = list(flags.models);
        if (models) input.allowed_models = models;
        const limit = sub === 'limit' ? args[0] : typeof flags.limit === 'string' ? flags.limit : undefined;
        if (sub === 'limit' && limit === undefined) throw new CliError('usage', 'Usage: create ai limit <usd>', 'Pass the monthly limit in dollars, e.g. 25.');
        if (limit !== undefined) {
          const n = Number(limit);
          if (!Number.isFinite(n) || n < 0) throw new CliError('usage', `Not an amount: ${limit}`, 'Pass the monthly limit in dollars, e.g. 25.');
          input.monthly_limit_usd = n;
        }
        const data = await call('configure_ai_gateway', input);
        const g = data.gateway as Gateway;
        out(io, json, g.enabled ? `AI Gateway on, limit ${usd(g.settings.monthlyLimitMicrousd)} a month. Reference ${g.references.url} and ${g.references.token} from your variables (create env set OPENAI_BASE_URL '${g.references.url}').` : 'AI Gateway off.', data);
        return 0;
      }
      if (sub === 'models') {
        const data = await call('get_ai_gateway', { project_id: l.projectId });
        const g = data.gateway as Gateway;
        // Cheapest first; --tools, --long-context, --reasoning, --vision keep only models that can (the cheapest that can do X is the
        // first line). Chat models by default; --embeddings lists the embedding models instead.
        const blend = (m: Gateway['models'][number]) => (3 * m.listPrice.input + m.listPrice.output) / 4;
        const wantKind = flags.embeddings === true ? 'embedding' : 'chat';
        const rows = g.models
          .filter((m) => (m.kind ?? 'chat') === wantKind)
          .filter((m) => (flags.tools !== true || m.tools !== false) && (flags['long-context'] !== true || (m.contextTokens ?? 0) >= 200_000) && (flags.reasoning !== true || (m.reasoning !== undefined && m.reasoning !== 'none')) && (flags.vision !== true || m.vision === true))
          .sort((a, b) => blend(a) - blend(b));
        const line = (m: Gateway['models'][number]) =>
          `${m.id}\t${m.allowed ? 'allowed' : 'not allowed'}\t${m.keySource === 'byok' ? 'own key' : m.keySource === 'create' ? `$${m.billedPrice.input} in / $${m.billedPrice.output} out per 1M` : 'no key'}${m.costIndex !== undefined ? `\t×${m.costIndex}` : ''}${m.tier ? `\t${m.tier}` : ''}`;
        const aliases = (g.aliases ?? []).filter((a) => a.resolvesTo).map((a) => `${a.id}\t→ ${a.resolvesTo}`);
        out(io, json, [...rows.map(line), ...aliases].join('\n'), data);
        return 0;
      }
      if (sub === 'estimate') {
        const model = args[0];
        const max = Number(flags['max-tokens'] ?? 1024);
        if (!Number.isInteger(max) || max < 1) throw new CliError('usage', 'Usage: create ai estimate [model] --max-tokens N (--input-bytes N | --input-tokens N)', 'max-tokens is a whole number of output tokens.');
        const num = (name: string) => (flags[name] === undefined ? undefined : Number(flags[name]));
        const inputBytes = num('input-bytes');
        const inputTokens = num('input-tokens');
        const images = num('images');
        const embeddings = num('embedding-inputs');
        if (inputBytes === undefined && inputTokens === undefined) throw new CliError('usage', 'Pass --input-bytes (the request body size) or --input-tokens', 'e.g. create ai estimate create/cheap --input-tokens 2000 --max-tokens 500');
        for (const [name, v] of [['input-bytes', inputBytes], ['input-tokens', inputTokens], ['images', images], ['embedding-inputs', embeddings]] as const) {
          if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new CliError('usage', `--${name} is a whole number`, `Pass --${name} 0 or more.`);
        }
        // --embedding-inputs N: an embeddings request of N inputs (input bytes = their total; no output).
        const shape = embeddings !== undefined ? { endpoint: 'embeddings', embedding_inputs: Math.max(1, embeddings) } : { max_tokens: max, ...(images !== undefined ? { images } : {}) };
        const data = await call('estimate_ai_cost', { project_id: l.projectId, ...shape, ...(model ? { model } : {}), ...(inputBytes !== undefined ? { input_bytes: inputBytes } : {}), ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}), ...(flags.tools === true ? { tools: true } : {}) });
        const e = data.estimate as { model: string; worstCaseMicrousd: number; typicalMicrousd: number; cheaper: { model: string; typicalMicrousd: number; costIndex: number }[] };
        const micro = (n: number) => `$${(n / 1_000_000).toFixed(n !== 0 && n < 10_000 ? 6 : 4)}`;
        out(io, json, [`${e.model}: typically ${micro(e.typicalMicrousd)}, expected maximum ${micro(e.worstCaseMicrousd)} reserved (overruns above the reserve are billed; estimate)`, ...e.cheaper.map((c) => `cheaper: ${c.model}\t${micro(c.typicalMicrousd)}\t×${c.costIndex}`)].join('\n'), data);
        return 0;
      }
      if (sub === 'default') {
        const target = args[0];
        if (!target) throw new CliError('usage', 'Usage: create ai default <model|alias|none>', 'e.g. create ai default create/cheap');
        const data = await call('configure_ai_gateway', { project_id: l.projectId, default_model: target === 'none' ? null : target });
        out(io, json, target === 'none' ? 'Requests without a model use Create’s default again.' : `Requests without a model (and create/default) now use ${target}.`, data);
        return 0;
      }
      if (sub === 'policy') {
        if (flags.reset === true) {
          const data = await call('configure_ai_gateway', { project_id: l.projectId, model_policy: null });
          out(io, json, 'Model policy back to the default: every provider hosted in the US or the EU.', data);
          return 0;
        }
        const policy: Record<string, unknown> = {};
        const providers = list(flags['deny-providers']);
        if (providers) policy.deny_providers = providers;
        const allowProviders = list(flags['allow-providers']);
        if (allowProviders) policy.allow_providers = allowProviders;
        const deny = list(flags['deny-countries']);
        if (deny) policy.deny_origin_countries = deny.map((c) => c.toUpperCase());
        const allow = list(flags['allow-countries']);
        if (allow) policy.allow_origin_countries = allow.map((c) => c.toUpperCase());
        const regions = list(flags.regions);
        if (regions) policy.hosting_regions = regions.map((r) => (r.toLowerCase() === 'global' ? 'global' : r.toUpperCase()));
        if (flags['open-weights-only'] !== undefined) policy.open_weights_only = flags['open-weights-only'] === true || flags['open-weights-only'] === 'true';
        if (flags['no-aggregators'] !== undefined) policy.no_aggregators = flags['no-aggregators'] === true || flags['no-aggregators'] === 'true';
        if (Object.keys(policy).length === 0) {
          const data = await call('get_ai_gateway', { project_id: l.projectId });
          const g = data.gateway as Gateway & { settings: { modelPolicy?: unknown } };
          out(io, json, JSON.stringify(g.settings.modelPolicy ?? null, null, 2), data);
          return 0;
        }
        const data = await call('configure_ai_gateway', { project_id: l.projectId, model_policy: policy });
        out(io, json, 'Model policy saved.', data);
        return 0;
      }
      if (sub === 'token' || sub === 'tokens') {
        const [action, arg] = args;
        if (action === 'create') {
          if (!arg) throw new CliError('usage', 'Usage: create ai token create <name> [--models a,b]', 'Name it after where it is used, e.g. laptop or ci.');
          const models = list(flags.models);
          const data = await call('create_ai_gateway_token', { project_id: l.projectId, name: arg, ...(models ? { models } : {}) });
          out(io, json, `${String(data.token)}\nShown once — store it as a secret (e.g. OPENAI_API_KEY in your local .env).`, data);
          return 0;
        }
        if (action === 'revoke') {
          if (!arg) throw new CliError('usage', 'Usage: create ai token revoke <id>', 'List token ids with `create ai`.');
          const data = await call('revoke_ai_gateway_token', { project_id: l.projectId, token_id: arg });
          out(io, json, `Revoked ${arg}.`, data);
          return 0;
        }
        throw new CliError('usage', `Unknown ai token command: ${action ?? ''}`, 'Use create or revoke.');
      }
      if (sub === 'rotate') {
        const data = await call('rotate_ai_gateway_token', { project_id: l.projectId, immediate: flags.immediate === true });
        out(io, json, data.graceEndsAt ? `Rotated. The old token works until ${String(data.graceEndsAt)}; redeploy containers before then.` : 'Rotated. The old token stopped working now; redeploy every service that references it.', data);
        return 0;
      }
      if (sub === 'key' || sub === 'keys') {
        const [action, provider] = args;
        const providers = ['openai', 'anthropic', 'google', 'mistral', 'xai', 'groq', 'together', 'fireworks', 'deepinfra', 'cerebras', 'openrouter'];
        if (!provider || !providers.includes(provider)) throw new CliError('usage', `Name the provider: ${providers.join(', ')}`, 'e.g. create ai key set anthropic');
        if (action === 'set') {
          const key = await (io.readSecret ?? ((prompt: string) => readSecretFrom(io, prompt)))(`${provider} API key (hidden): `);
          if (!key) throw new CliError('empty_secret', 'No key was given', 'Type it at the prompt, or pipe it on stdin.');
          const data = await call('set_ai_provider_key', { project_id: l.projectId, provider, key });
          out(io, json, `Stored your own ${provider} key; ${provider} requests now use it and Create bills nothing for them.`, data);
          return 0;
        }
        if (action === 'rm' || action === 'remove') {
          const data = await call('remove_ai_provider_key', { project_id: l.projectId, provider });
          out(io, json, data.removed ? `Removed your own ${provider} key.` : `There was no ${provider} key of your own.`, data);
          return 0;
        }
        throw new CliError('usage', `Unknown ai key command: ${action ?? ''}`, 'Use set or rm.');
      }
      if (sub === 'requests' || sub === 'logs') {
        const data = await call('list_ai_requests', { project_id: l.projectId, ...(typeof flags.model === 'string' ? { model: flags.model } : {}), ...(typeof flags.status === 'string' ? { status: flags.status } : {}) });
        const rows = data.requests as { startedAt: string; model: string; status: string; errorCode: string | null; inputTokens: number; outputTokens: number; billedMicrousd: number }[];
        out(io, json, rows.length ? rows.map((r) => `${r.startedAt}\t${r.model}\t${r.status}${r.errorCode ? ` (${r.errorCode})` : ''}\t${r.inputTokens}→${r.outputTokens}\t${usd(r.billedMicrousd)}`).join('\n') : 'No requests yet.', data);
        return 0;
      }
      throw new CliError('usage', `Unknown ai command: ${sub}`, 'Use enable, disable, limit, models, estimate, default, policy, token, rotate, key or requests.');
    }

    // A5: persistent volumes and managed Valkey, through the same tools an AI connection uses.
    if (cmd === 'volumes' || cmd === 'volume') {
      const l = requireLink();
      const [sub = 'list', target] = rest;
      const intFlag = (name: string): number | undefined => {
        if (flags[name] === undefined) return undefined;
        const n = Number(flags[name]);
        if (!Number.isInteger(n) || n < 1) throw new CliError('usage', `--${name} is a whole number of GB`, `Pass --${name} 1 or more.`);
        return n;
      };
      if (sub === 'list' || sub === 'ls') {
        const data = await call('list_storage', { project_id: l.projectId });
        const volumes = data.volumes as { id: string; name: string; sizeGb: number; mountPath: string; status: string; serviceId: string | null }[];
        const valkey = data.valkey as { id: string; name: string; status: string; size: string }[];
        const lines = [
          ...(volumes.length ? volumes.map((v) => `volume ${v.name} · ${v.sizeGb} GB at ${v.mountPath} · ${v.status}${v.serviceId ? '' : ' · detached'} · ${v.id}`) : ['No volumes.']),
          ...valkey.map((k) => `valkey ${k.name} · ${k.size} · ${k.status} · reference \${{${k.name}.REDIS_URL}}`),
        ];
        out(io, json, lines.join('\n'), data);
        return 0;
      }
      if (sub === 'add') {
        if (!target) throw new CliError('usage', 'Usage: create volumes add <mount path> [--size-gb <n>] [--name <name>]', 'Pass the directory to mount it at, e.g. /data.');
        const project = await backend.getProject(l.projectId);
        const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
        if (!svc) throw new CliError('service_not_found', `No service named ${String(flags.service ?? l.service)} in ${l.projectName}`, 'Deploy it first (create deploy), or pass --service <name>.');
        const size = intFlag('size-gb');
        const data = await call('add_volume', { project_id: l.projectId, service_id: svc.id, mount_path: target, ...(size !== undefined ? { size_gb: size } : {}), ...(typeof flags.name === 'string' ? { name: flags.name } : {}) });
        const v = data.volume as { name: string; sizeGb: number; mountPath: string };
        out(io, json, `Volume ${v.name} (${v.sizeGb} GB) is attached to ${svc.name} at ${v.mountPath}. Run create deploy to mount it; ${svc.name} now runs one replica.`, data);
        return 0;
      }
      if (sub === 'snapshot') {
        if (!target) throw new CliError('usage', 'Usage: create volumes snapshot <name|id>', 'Pass the volume’s name or id (create volumes lists them).');
        const listed = (await call('list_storage', { project_id: l.projectId })).volumes as { id: string; name: string }[];
        const volume = listed.find((v) => v.id === target || v.name === target);
        if (!volume) throw new CliError('volume_not_found', `No volume named ${target} in ${l.projectName}`, 'Run create volumes to see the project’s volumes.');
        const data = await call('snapshot_volume', { volume_id: volume.id });
        const snap = data.snapshot as { id: string; status: string; expiresAt: string | null };
        out(io, json, `Snapshot ${snap.id} of ${volume.name} is ${snap.status}${snap.expiresAt ? `; kept until ${snap.expiresAt}` : ''}.`, data);
        return 0;
      }
      throw new CliError('usage', `Unknown volumes command: ${sub}`, 'Use create volumes, create volumes add <mount path>, or create volumes snapshot <name>.');
    }

    if (cmd === 'valkey') {
      const l = requireLink();
      const [sub, name] = rest;
      if (sub === 'backup' || sub === 'backups') {
        if (!name) throw new CliError('usage', `Usage: create valkey ${sub} <name|id>`, 'Pass the Valkey’s name or id (create volumes lists them).');
        const listed = (await call('list_storage', { project_id: l.projectId })).valkey as { id: string; name: string }[];
        const valkey = listed.find((k) => k.id === name || k.name === name);
        if (!valkey) throw new CliError('valkey_not_found', `No Valkey named ${name} in ${l.projectName}`, 'Run create volumes to see the project’s Valkey instances.');
        if (sub === 'backup') {
          const data = await call('backup_valkey', { valkey_id: valkey.id });
          const b = data.backup as { id: string; status: string; expiresAt: string | null };
          out(io, json, `Backup ${b.id} of ${valkey.name} is ${b.status}${b.expiresAt ? `; kept until ${b.expiresAt}` : ''}.`, data);
          return 0;
        }
        const data = await call('list_valkey_backups', { valkey_id: valkey.id });
        const rows = data.backups as { id: string; kind: string; status: string; sizeBytes: number | null; expiresAt: string | null }[];
        out(io, json, rows.length ? rows.map((b) => `${b.id}\t${b.kind}\t${b.status}\t${b.sizeBytes ?? '-'}\t${b.expiresAt ?? '-'}`).join('\n') : `No backups of ${valkey.name} yet.`, data);
        return 0;
      }
      if (sub !== 'add') throw new CliError('usage', 'Usage: create valkey add [name] [--size <S|M|…>] [--storage-gb <n>] [--eviction <policy>] | backup <name> | backups <name>', 'List Valkey databases with create volumes.');
      const storage = flags['storage-gb'] === undefined ? undefined : Number(flags['storage-gb']);
      if (storage !== undefined && (!Number.isInteger(storage) || storage < 1)) throw new CliError('usage', '--storage-gb is a whole number of GB', 'Pass --storage-gb 1 or more.');
      const data = await call('add_database', {
        project_id: l.projectId,
        engine: 'valkey',
        ...(name ? { name } : {}),
        ...(typeof flags.size === 'string' ? { size: flags.size } : {}),
        ...(storage !== undefined ? { storage_gb: storage } : {}),
        ...(typeof flags.eviction === 'string' ? { eviction_policy: flags.eviction } : {}),
      });
      const k = data.valkey as { name: string; status: string; size: string };
      out(io, json, `Valkey ${k.name} (${k.size}) is ${k.status}. Services reach it as \${{${k.name}.REDIS_URL}}${data.wired ? '; the shared REDIS_URL now references it — run create deploy to pick it up' : ''}.`, data);
      return 0;
    }

    if (cmd === 'rollback') {
      const l = requireLink();
      let target = rest[0];
      if (!target) {
        const project = await backend.getProject(l.projectId);
        const svc = project.services.find((s) => s.name === String(flags.service ?? l.service));
        if (!svc) throw new CliError('service_not_found', 'Nothing deployed to roll back', 'Deploy first.');
        const history: Deployment[] = await backend.listDeployments(svc.id);
        const previous = history.find((d) => !d.current && (d.status === 'live' || d.status === 'superseded'));
        if (!previous) throw new CliError('nothing_to_roll_back', 'There is no earlier live deployment', 'Pass a deployment id, or deploy a fixed version.');
        target = previous.id;
      }
      const data = await call('rollback', { deployment_id: target });
      const rolled = (data.deployment as { id: string }).id;
      // An edge frontend's rollback makes the target itself current again (no new deployment); a
      // container rollback starts a NEW deployment that re-uses the target's image and config.
      out(io, json, rolled === target || data.instant === true ? `Rolled back: production now serves deployment ${target}.` : `Rolling back to ${target}: new deployment ${rolled} re-uses it.`, data);
      return 0;
    }

    if (cmd === 'promote') {
      const target = rest[0];
      if (!target) throw new CliError('usage', 'Usage: create promote <deploymentId> [--allow-build-time-drift]', 'Pass the deployment id a preview deploy (or a staged production deploy) printed.');
      const data = await call('promote_deployment', { deployment_id: target, allow_build_time_drift: flags['allow-build-time-drift'] === true });
      const d = data.deployment as { id: string; url?: string | null };
      out(io, json, `Promoted ${target} (${String(data.mode)}): deployment ${d.id} is live in production${d.url ? ` at ${d.url}` : ''}.`, data);
      return 0;
    }

    if (cmd === 'usage') {
      const l = requireLink();
      const data = await call('get_edge_usage', { project_id: l.projectId });
      const u = data.usage as { month: string; plan: string; hardCap: boolean; meters: Record<string, { used: number; included: number; percent: number }>; paused: { until: string } | null; metering: boolean };
      const row = (name: string, m: { used: number; included: number; percent: number }) => `${name.padEnd(9)} ${m.used.toLocaleString('en-US')} of ${m.included.toLocaleString('en-US')} (${m.percent}%)`;
      // A8: the account's plan and usage after the project's, when this sign-in has billing access.
      const account = await backend.getBillingUsage?.({}).catch(() => null);
      if (account) data.billing = account;
      const human = [
        `Edge usage ${u.month} · ${u.plan}${u.hardCap ? ' (hard cap)' : ''}`,
        row('requests', u.meters.requests!),
        row('CPU ms', u.meters.cpuMs!),
        row('bytes', u.meters.bytes!),
        u.paused ? `Paused until ${u.paused.until}: the Hobby allowance ran out. Upgrade to Pro to bring it back now.` : '',
        u.metering ? '' : 'Usage collection is not switched on for this Create deployment yet.',
        ...(account ? ['', ...billingSummary(account)] : []),
      ];
      out(io, json, human.filter(Boolean).join('\n'), data);
      return 0;
    }

    throw new CliError('unknown_command', `Unknown command: ${cmd}`, 'Run create help.');
  } catch (error) {
    const json = flags.json === true;
    const e =
      error instanceof CliError || error instanceof AuthError || error instanceof AgentError || error instanceof PackError || error instanceof LinkError
        ? { code: error.code, message: error.message, fix: (error as { fix: string }).fix }
        : { code: 'unexpected', message: error instanceof Error ? error.message : String(error), fix: 'Retry; if it keeps failing, report this message.' };
    if (json) io.stdout.write(`${JSON.stringify({ ok: false, error: e })}\n`);
    else io.stderr.write(`Error (${e.code}): ${e.message}${e.fix ? `\nFix: ${e.fix}` : ''}\n`);
    return 1;
  }
}

/** Files above this go up in parts (the Hobby single-request ceiling; Pro allows 500 MB in one request, but parts resume better). */
export const BLOB_PUT_SINGLE_MAX = 100 * 1024 * 1024;

type MultipartBackend = Pick<HttpAppsBackend, 'createBlobMultipartUpload' | 'createBlobPartUrls' | 'abortBlobMultipartUpload'>;

/**
 * S1: a large file in parts — the upload is started (its size reserved), each part read from disk at its
 * offset and PUT to its own signed URL (no token on the wire), then completed through the signed
 * completion URL. Any failure aborts the upload, so no quota stays reserved.
 */
async function putMultipartFile(
  backend: MultipartBackend,
  io: { fetchImpl: typeof fetch },
  storeId: string,
  path: string,
  size: number,
  input: { pathname: string; contentType?: string; addRandomSuffix: boolean; allowOverwrite: boolean },
): Promise<Record<string, unknown>> {
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AgentError) throw new CliError(error.code, error.message, error.fix);
      throw error;
    }
  };
  const started = await call(() => backend.createBlobMultipartUpload(storeId, { pathname: input.pathname, size, contentType: input.contentType, addRandomSuffix: input.addRandomSuffix, allowOverwrite: input.allowOverwrite }));
  const partSize = started.partSize;
  const count = Math.max(1, Math.ceil(size / partSize));
  const failure = async (res: Response): Promise<CliError> => {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return new CliError(String(body.error ?? `http_${res.status}`), String(body.message ?? `Upload failed (${res.status})`), String(body.fix ?? 'Try again.'));
  };
  const fd = openSync(path, 'r');
  try {
    const etags: { partNumber: number; etag: string }[] = [];
    let completeUrl: string | null = null;
    for (let first = 1; first <= count; first += 1000) {
      const last = Math.min(count, first + 999);
      const wanted: { partNumber: number; size: number }[] = [];
      for (let n = first; n <= last; n++) wanted.push({ partNumber: n, size: Math.min(size, n * partSize) - (n - 1) * partSize });
      const signed = await call(() => backend.createBlobPartUrls(storeId, started.uploadId, { parts: wanted, complete: last === count }));
      for (const part of signed.parts) {
        const buffer = Buffer.alloc(part.size);
        readSync(fd, buffer, 0, part.size, (part.partNumber - 1) * partSize);
        const res = await io.fetchImpl(part.url, { method: 'PUT', body: buffer as unknown as NonNullable<RequestInit['body']> });
        if (!res.ok) throw await failure(res);
        const r = (await res.json()) as { partNumber: number; etag: string };
        etags.push({ partNumber: r.partNumber, etag: r.etag });
      }
      if (signed.completeUrl) completeUrl = signed.completeUrl;
    }
    const res = await io.fetchImpl(completeUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: etags }) });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as Record<string, unknown>;
  } catch (error) {
    await backend.abortBlobMultipartUpload(storeId, started.uploadId).catch(() => undefined);
    throw error;
  } finally {
    closeSync(fd);
  }
}
