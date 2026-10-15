import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { handleRpc, RPC, type ServerInfo } from './server.js';
import type { ToolContext } from './tools.js';

/**
 * The stdio binding: newline-delimited JSON-RPC on stdin/stdout, used by `create mcp`. Nothing but
 * protocol messages is ever written to `output` (logs go to stderr), and the CLI's token never
 * appears in a message: stdio servers take credentials from their environment, not from the protocol
 * (MCP authorization spec: "Implementations using an STDIO transport SHOULD NOT follow this
 * specification, and instead retrieve credentials from the environment").
 *
 * Elicitation (MCP 2025-06-18 `elicitation/create`): stdio is a two-way channel, so when the client
 * declared the `elicitation` capability in `initialize` (once per session), tools get `ctx.elicit` and can ask the person a question — `deploy` uses it to pick or
 * create the project. The client's answer is matched by id BEFORE the request queue, because the tool
 * call waiting for it holds the queue. Responses with an id we never asked about are ignored (never
 * answered). `ping` is answered at once, even while a long tool call (a local build) holds the queue.
 * `notifications/cancelled` aborts the named call (`ctx.signal`: the build's process group is killed,
 * nothing is deployed after it) or drops it unanswered if it has not started.
 */

/** How long a question may stay unanswered before it counts as cancelled. */
const ELICIT_TIMEOUT_MS = 10 * 60 * 1000;

type ElicitAnswer = Awaited<ReturnType<NonNullable<ToolContext['elicit']>>>;

export function runStdio(ctx: ToolContext, opts: { serverInfo: ServerInfo; input: Readable; output: Writable }): Promise<void> {
  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  const write = (value: unknown) => opts.output.write(`${JSON.stringify(value)}\n`);
  let queue = Promise.resolve();
  let clientCanElicit = false;
  let seq = 0;
  const pending = new Map<string, (answer: ElicitAnswer) => void>();
  /** Calls queued or running, by JSON-RPC id, so a cancel can abort them. */
  const calls = new Map<string, AbortController>();
  /** Calls whose tool is running now (not merely queued). */
  const running = new Set<AbortController>();
  /** Calls the client cancelled (notifications/cancelled): never answered. */
  const cancelled = new WeakSet<AbortController>();
  const idKey = (id: unknown) => (typeof id === 'string' || typeof id === 'number' ? `${typeof id}:${id}` : null);

  /** A question tied to one call: cancelling the call (or closing the input) cancels the question. */
  const elicitFor = (signal: AbortSignal): NonNullable<ToolContext['elicit']> => (request) => {
    if (signal.aborted) return Promise.resolve({ action: 'cancel' as const });
    return new Promise<ElicitAnswer>((resolveAnswer, rejectAnswer) => {
      const id = `create-elicit-${++seq}`;
      signal.addEventListener('abort', () => pending.get(id)?.({ action: 'cancel' }), { once: true });
      const timer = setTimeout(() => {
        pending.delete(id);
        resolveAnswer({ action: 'cancel' });
      }, ELICIT_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, (answer) => {
        clearTimeout(timer);
        pending.delete(id);
        if ((answer as { error?: unknown }).error) rejectAnswer(new Error('the client could not ask the question'));
        else resolveAnswer(answer);
      });
      write({ jsonrpc: '2.0', id, method: 'elicitation/create', params: request });
    });
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      queue = queue.then(() => void write({ jsonrpc: '2.0', id: null, error: { code: RPC.parseError, message: 'Parse error' } }));
      return;
    }
    const msg = (message && typeof message === 'object' ? message : {}) as { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: unknown; error?: unknown };
    // A client's answer to one of our questions; any other response (unknown id) is ignored.
    if (msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      if (typeof msg.id !== 'string' || !pending.has(msg.id)) return;
      const settle = pending.get(msg.id)!;
      if (msg.error !== undefined) settle({ action: 'cancel', error: msg.error } as ElicitAnswer);
      else {
        const r = (msg.result && typeof msg.result === 'object' ? msg.result : {}) as { action?: unknown; content?: unknown };
        const action = r.action === 'accept' || r.action === 'decline' ? r.action : 'cancel';
        settle({ action, ...(r.content && typeof r.content === 'object' ? { content: r.content as Record<string, unknown> } : {}) });
      }
      return;
    }
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (msg.method === 'initialize') {
      const caps = (params.capabilities && typeof params.capabilities === 'object' ? params.capabilities : {}) as Record<string, unknown>;
      clientCanElicit = caps.elicitation !== undefined && caps.elicitation !== null;
    }
    if (msg.method === 'notifications/cancelled') {
      const key = idKey(params.requestId);
      const c = key ? calls.get(key) : undefined;
      if (c) {
        cancelled.add(c);
        c.abort();
      }
      return;
    }
    if (msg.method === 'ping' && msg.id !== undefined) {
      void handleRpc(message, ctx, { serverInfo: opts.serverInfo, transport: 'stdio' }).then((outcome) => outcome.response && write(outcome.response));
      return;
    }
    const key = idKey(msg.id);
    const controller = new AbortController();
    if (key) calls.set(key, controller);
    // Answer in order: a client may pipeline requests, and results must not overtake each other.
    queue = queue.then(async () => {
      if (cancelled.has(controller)) {
        if (key) calls.delete(key);
        return; // cancelled before it started: no answer (MCP cancellation)
      }
      running.add(controller);
      const callCtx: ToolContext = { ...ctx, ...(clientCanElicit ? { elicit: elicitFor(controller.signal) } : {}), signal: controller.signal };
      try {
        const outcome = await handleRpc(message, callCtx, { serverInfo: opts.serverInfo, transport: 'stdio' });
        if (outcome.response && !cancelled.has(controller)) write(outcome.response);
      } catch {
        if (!cancelled.has(controller)) write({ jsonrpc: '2.0', id: (message as { id?: unknown })?.id ?? null, error: { code: RPC.internal, message: 'Internal error' } });
      } finally {
        running.delete(controller);
        if (key) calls.delete(key);
      }
    });
  });
  return new Promise((resolve) =>
    rl.on('close', () => {
      // Input closed: the client is gone. Open questions count as cancelled, and a call still RUNNING is
      // aborted (a local build's process group is killed; nothing is created or deployed after it). Its
      // answer is still written, for whoever reads the output. Calls queued behind it still run.
      for (const settle of [...pending.values()]) settle({ action: 'cancel' });
      for (const c of running) c.abort();
      void queue.then(() => resolve());
    }),
  );
}
