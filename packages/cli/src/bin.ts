#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { run } from './cli.js';

/**
 * Opens the verification URL in the default browser, best-effort, never through a shell: the URL is
 * an argument, not a command line. `CREATE_NO_BROWSER=1` (or a CI environment) skips it.
 */
function openBrowser(url: string): void {
  if (process.env.CREATE_NO_BROWSER || process.env.CI || !/^https?:\/\//.test(url)) return;
  const [cmd, args] = platform() === 'darwin' ? ['open', [url]] : platform() === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // No browser: the URL is printed anyway.
  }
}

// Ctrl-C lets a long-running command (`create logs --follow`) end cleanly; anything still running a
// moment later (a deploy being waited on) exits as Ctrl-C always did.
const interrupt = new AbortController();
// An MCP client shutting the server down sends SIGTERM: exit (which kills any local build's process group).
process.once('SIGTERM', () => {
  interrupt.abort();
  process.exit(143);
});
process.once('SIGINT', () => {
  interrupt.abort();
  setTimeout(() => process.exit(130), 1500).unref();
  process.once('SIGINT', () => process.exit(130));
});

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  fetchImpl: fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  openBrowser,
  signal: interrupt.signal,
  // Questions (which project to link) only on a terminal; agents piping stdin never get one.
  interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  // A6: psql inherits the terminal; the session travels in its environment, never its arguments.
  runPsql: (env) =>
    new Promise((resolveExit) => {
      const child = spawn('psql', [], { stdio: 'inherit', env: { ...process.env, ...env } });
      child.on('error', () => {
        process.stderr.write('psql was not found on PATH: install the PostgreSQL client, or run create db connect --json for the connection details.\n');
        resolveExit(1);
      });
      child.on('exit', (code) => resolveExit(code ?? 1));
    }),
});
process.exitCode = code;
