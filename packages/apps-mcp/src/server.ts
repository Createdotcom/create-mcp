import { AgentError, InsufficientScope } from './errors.js';
import { callTool, listTools, UnknownTool, type ToolContext } from './tools.js';

/**
 * A small dual-era MCP server core (no SDK dependency, so the CLI stays light): one function that
 * takes a JSON-RPC message and answers it, shared by the streamable HTTP endpoint and stdio.
 *
 * - MODERN (revision 2026-07-28): every request carries `_meta["io.modelcontextprotocol/protocolVersion"]`;
 *   there is no handshake; `server/discover` is implemented; results carry `resultType: "complete"`.
 * - LEGACY (2025-11-25, 2025-06-18, 2025-03-26): `initialize` negotiates a version; no session is
 *   minted (the server is stateless); `notifications/initialized` is accepted.
 *
 * Only tools are offered (no resources, prompts, sampling or subscriptions), so nothing here ever
 * needs server-initiated messages — which is what lets one stateless endpoint serve both eras.
 */

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** How long a modern client may reuse a `tools/list` answer: short, so a changed grant shows soon. */
export const TOOLS_LIST_TTL_MS = 300_000;

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

export type ServerInfo = { name: string; title: string; version: string; websiteUrl?: string };

export const SERVER_INSTRUCTIONS = [
  'Create app hosting: put an app on Create in a few calls.',
  'Happy path for a site: deploy with the folder (path, local create mcp), files or an upload — it picks the project (named, the folder’s linked one, or asks the person) or creates it, builds and returns the URL; poll get_deployment until live when it is still building. For a container image: create_project (or list_projects) → deploy_image → get_deployment.',
  'Secrets go in set_variables with secret: true and are never shown back. Every deploy states its monthly cost; get_usage shows this connection’s limits.',
  'Deleting needs the project’s exact name; confirm with the person first.',
  'A claim link from an anonymous deploy (…/account/apps/claim#token=ccl_…) moves that deploy into this account with claim_deployment.',
].join(' ');

/** P2 (§8.5): what the unauthenticated anonymous endpoint tells a model. */
export const ANONYMOUS_SERVER_INSTRUCTIONS = [
  'Create anonymous previews: put a static site (built HTML, CSS, JavaScript and assets) on a public URL with no account.',
  'Call deploy_preview with the files; poll get_preview while it builds.',
  'The answer carries a claim link shown ONCE: give it to the person right away — opening it signed in to Create keeps the app; unclaimed previews are deleted after 72 hours, and every page shows a banner until claimed.',
  'Previews serve static files only: no builds, no Worker or server code, no secrets or environment variables. For frameworks and servers, the person connects the signed-in Create MCP server.',
].join(' ');

export function instructionsFor(ctx: ToolContext): string {
  return ctx.anonymous ? ANONYMOUS_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

type JsonRpcId = string | number;
export type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId | null; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

/** What a transport learns from answering one message. `status` is the HTTP status that transport should use. */
export type RpcOutcome = { response: JsonRpcResponse | null; status: number; insufficientScope?: InsufficientScope };

export type RequestHeaders = { protocolVersion?: string | null; method?: string | null; name?: string | null };

function err(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** `=?base64?…?=` (streamable HTTP "Value Encoding"). */
export function decodeHeaderValue(value: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  if (!m) return value;
  try {
    return Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export async function handleRpc(
  message: unknown,
  ctx: ToolContext,
  opts: { serverInfo: ServerInfo; headers?: RequestHeaders; transport: 'http' | 'stdio' },
): Promise<RpcOutcome> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { response: err(null, RPC.invalidRequest, 'Send one JSON-RPC request object (batches are not supported)'), status: 400 };
  }
  const msg = message as Partial<JsonRpcRequest>;
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { response: err(id, RPC.invalidRequest, 'Not a JSON-RPC 2.0 request'), status: 400 };
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
  const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
  const modernVersion = typeof meta[META_VERSION] === 'string' ? (meta[META_VERSION] as string) : null;

  if (isNotification) {
    // notifications/initialized (legacy), notifications/cancelled (stdio): nothing to do, nothing to say.
    return { response: null, status: 202 };
  }

  // ---------------------------------------------------------------- modern (2026-07-28)
  if (modernVersion !== null) {
    if (modernVersion !== MODERN_PROTOCOL_VERSION) {
      return { response: err(id, RPC.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: modernVersion }), status: 400 };
    }
    if (opts.transport === 'http') {
      const h = opts.headers ?? {};
      if (h.protocolVersion !== modernVersion) return { response: err(id, RPC.headerMismatch, `Header mismatch: MCP-Protocol-Version must be ${modernVersion}`), status: 400 };
      if (h.method !== msg.method) return { response: err(id, RPC.headerMismatch, `Header mismatch: Mcp-Method header value '${h.method ?? ''}' does not match body value '${msg.method}'`), status: 400 };
      if (msg.method === 'tools/call') {
        const name = h.name ? decodeHeaderValue(h.name) : null;
        if (name !== params.name) return { response: err(id, RPC.headerMismatch, `Header mismatch: Mcp-Name header value '${name ?? ''}' does not match body value '${String(params.name)}'`), status: 400 };
      }
    }
    const complete = (result: Record<string, unknown>): RpcOutcome => ({ response: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } }, status: 200 });
    switch (msg.method) {
      case 'server/discover':
        return complete({
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          _meta: { 'io.modelcontextprotocol/serverInfo': opts.serverInfo },
          instructions: instructionsFor(ctx),
        });
      case 'ping':
        return complete({});
      case 'tools/list':
        // 2026-07-28 list results carry cache hints, and clients reject a list without them. The list
        // depends on the caller's grants (anonymous vs signed-in, scopes), so it is private to them.
        return complete({ tools: listTools(ctx), ttlMs: TOOLS_LIST_TTL_MS, cacheScope: 'private' });
      case 'tools/call':
        return runTool(id, params, ctx, (result) => complete(result));
      default:
        return { response: err(id, RPC.methodNotFound, `Method not found: ${msg.method}`), status: opts.transport === 'http' ? 404 : 200 };
    }
  }

  // ---------------------------------------------------------------- legacy (initialize era)
  if (opts.transport === 'http' && opts.headers?.protocolVersion && msg.method !== 'initialize' && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(opts.headers.protocolVersion)) {
    return { response: err(id, RPC.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: opts.headers.protocolVersion }), status: 400 };
  }
  const result = (value: Record<string, unknown>): RpcOutcome => ({ response: { jsonrpc: '2.0', id, result: value }, status: 200 });
  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0];
      return result({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: opts.serverInfo, instructions: instructionsFor(ctx) });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: listTools(ctx) });
    case 'tools/call':
      return runTool(id, params, ctx, result);
    default:
      return { response: err(id, RPC.methodNotFound, `Method not found: ${msg.method}`), status: 200 };
  }
}

async function runTool(id: JsonRpcId | null, params: Record<string, unknown>, ctx: ToolContext, wrap: (r: Record<string, unknown>) => RpcOutcome): Promise<RpcOutcome> {
  if (typeof params.name !== 'string') return { response: err(id, RPC.invalidParams, 'tools/call needs a tool name'), status: 400 };
  try {
    const out = await callTool(params.name, params.arguments, ctx);
    return wrap({ ...out, isError: out.isError ?? false });
  } catch (error) {
    if (error instanceof UnknownTool) return { response: err(id, RPC.invalidParams, `Unknown tool: ${params.name}`), status: 200 };
    if (error instanceof InsufficientScope) {
      return { response: err(id, RPC.invalidRequest, error.message, { error: error.toJSON() }), status: 403, insufficientScope: error };
    }
    if (error instanceof AgentError) return wrap({ content: [{ type: 'text', text: `Error (${error.code}): ${error.message}\nFix: ${error.fix}` }], isError: true });
    return { response: err(id, RPC.internal, 'Internal error: the tool failed unexpectedly. Retry once; if it fails again, report it.'), status: 500 };
  }
}
