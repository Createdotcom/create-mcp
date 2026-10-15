import { handleRpc, RPC, type ServerInfo } from './server.js';
import type { ToolContext } from './tools.js';

/**
 * The streamable HTTP binding (MCP 2026-07-28, stateless; also serving 2025-03-26…2025-11-25 clients
 * without sessions): POST one JSON-RPC message, get one JSON response (`application/json`) or `202`
 * for a notification. GET and DELETE answer 405 (no standalone SSE stream, no sessions).
 *
 * Authentication happens BEFORE the body is parsed: every request needs `Authorization: Bearer …`,
 * and a missing or rejected token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`
 * (RFC 9728 §5.1) so clients can discover the authorization server. A tool the grant lacks the scope
 * for gets `403` with `error="insufficient_scope"` and every scope the call needs in one challenge.
 */

export type HttpAuth =
  | { ok: true; ctx: ToolContext }
  | { ok: false; status: 401; challenge: string; error: string; description: string };

export type McpHttpOptions = {
  serverInfo: ServerInfo;
  /** Resolve the bearer token into a tool context (backend + the grant's scopes). */
  authenticate: (request: Request) => Promise<HttpAuth>;
  /** Streamable HTTP "MUST validate the Origin header": true when absent or allowed. */
  originAllowed: (origin: string) => boolean;
  /** The `WWW-Authenticate` value for an insufficient-scope challenge. */
  scopeChallenge: (scopes: string[], description: string) => string;
  maxBodyBytes?: number;
};

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** The body as text, or null as soon as more than `limit` bytes have arrived (the stream is cancelled). */
export async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleMcpHttp(request: Request, opts: McpHttpOptions): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && !opts.originAllowed(origin)) return rpcError(403, RPC.invalidRequest, 'Origin not allowed');
  if (request.method === 'GET' || request.method === 'DELETE') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

  const auth = await opts.authenticate(request);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error, error_description: auth.description }), {
      status: 401,
      headers: { ...JSON_HEADERS, 'www-authenticate': auth.challenge },
    });
  }

  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return rpcError(415, RPC.invalidRequest, 'Send Content-Type: application/json');
  const limit = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) return rpcError(413, RPC.invalidRequest, `Request body over ${limit} bytes`);
  // Counted while streaming, so a body with no (or a lying) Content-Length is cut off at the limit
  // instead of being buffered whole.
  const text = await readCapped(request, limit);
  if (text === null) return rpcError(413, RPC.invalidRequest, `Request body over ${limit} bytes`);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(400, RPC.parseError, 'Parse error: the body is not JSON');
  }

  const outcome = await handleRpc(message, auth.ctx, {
    serverInfo: opts.serverInfo,
    transport: 'http',
    headers: {
      protocolVersion: request.headers.get('mcp-protocol-version'),
      method: request.headers.get('mcp-method'),
      name: request.headers.get('mcp-name'),
    },
  });
  if (!outcome.response) return new Response(null, { status: 202 });
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (outcome.insufficientScope) headers['www-authenticate'] = opts.scopeChallenge(outcome.insufficientScope.requiredScopes, outcome.insufficientScope.message);
  return new Response(JSON.stringify(outcome.response), { status: outcome.status, headers });
}
