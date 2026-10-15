import { clearCredentials, loadCredentials, saveCredentials, withCredentialsLock, type StoredCredentials } from './config.js';

/**
 * Sign-in for the CLI: the OAuth 2.0 device authorization grant (RFC 8628) against Create's
 * authorization server, as the first-party public client `create-cli` (spec §8.1 "`create login`
 * (OAuth device flow for the CLI)"). The token is requested for the Admin API resource
 * (`<api>/v1/apps`, RFC 8707) — the CLI talks REST, never the remote MCP endpoint.
 */

export const CLI_CLIENT_ID = 'create-cli';

export type AuthIo = {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Where human-readable progress goes (stderr in the real CLI, so --json stdout stays clean). */
  say: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  openBrowser?: (url: string) => void;
};

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

const form = (params: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

export async function login(apiUrl: string, io: AuthIo, opts: { timeoutMs?: number } = {}): Promise<StoredCredentials> {
  const resource = `${apiUrl}/v1/apps`;
  const start = await io.fetchImpl(`${apiUrl}/oauth/device_authorization`, form({ client_id: CLI_CLIENT_ID, resource, scope: 'apps:read apps:deploy apps:configure apps:delete' }));
  if (!start.ok) throw new AuthError('login_failed', `Create refused to start a sign-in (${start.status})`, 'Check the API URL (CREATE_API_URL) and try again.');
  const device = (await start.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number };
  io.say(`To sign in, open ${device.verification_uri} and enter the code ${device.user_code}`);
  if (device.verification_uri_complete) io.say(`(or open ${device.verification_uri_complete})`);
  io.openBrowser?.(device.verification_uri_complete ?? device.verification_uri);

  let interval = Math.max(1, device.interval) * 1000;
  const deadline = io.now() + Math.min(device.expires_in * 1000, opts.timeoutMs ?? Number.POSITIVE_INFINITY);
  while (io.now() < deadline) {
    await io.sleep(interval);
    const res = await io.fetchImpl(`${apiUrl}/oauth/token`, form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: CLI_CLIENT_ID }));
    const body = (await res.json()) as Partial<TokenResponse> & { error?: string; error_description?: string };
    if (res.ok && body.access_token && body.refresh_token) {
      const creds: StoredCredentials = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: io.now() + (body.expires_in ?? 3600) * 1000, clientId: CLI_CLIENT_ID };
      saveCredentials(apiUrl, creds, io.env);
      return creds;
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (body.error === 'access_denied') throw new AuthError('access_denied', 'The sign-in was declined in the browser', 'Run create login again and approve it.');
    if (body.error === 'expired_token') break;
    throw new AuthError(body.error ?? 'login_failed', body.error_description ?? 'The sign-in failed', 'Run create login again.');
  }
  throw new AuthError('login_expired', 'The sign-in code expired before it was approved', 'Run create login again and approve it within 15 minutes.');
}

/** A valid access token, refreshing (and storing the rotated pair) when the stored one has expired. */
export async function accessToken(apiUrl: string, io: Pick<AuthIo, 'fetchImpl' | 'now' | 'env'> & { sleep?: (ms: number) => Promise<void> }, force = false): Promise<string> {
  const creds = loadCredentials(apiUrl, io.env);
  if (!creds) throw new AuthError('not_signed_in', 'You are not signed in to Create', 'Run create login.');
  if (!force && creds.expiresAt - 60_000 > io.now()) return creds.accessToken;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return withCredentialsLock(io.env, sleep, async () => {
    // Read again under the lock: another process may have refreshed while we waited, and its
    // rotated refresh token is the only one that still works.
    const fresh = loadCredentials(apiUrl, io.env);
    if (!fresh) throw new AuthError('not_signed_in', 'You are not signed in to Create', 'Run create login.');
    if (fresh.accessToken !== creds.accessToken && fresh.expiresAt - 60_000 > io.now()) return fresh.accessToken;
    if (!force && fresh.expiresAt - 60_000 > io.now()) return fresh.accessToken;
    const res = await io.fetchImpl(`${apiUrl}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: fresh.refreshToken, client_id: fresh.clientId }));
    const body = (await res.json()) as Partial<TokenResponse> & { error?: string };
    if (!res.ok || !body.access_token || !body.refresh_token) {
      clearCredentials(apiUrl, io.env);
      throw new AuthError('session_expired', 'Your Create sign-in expired or was revoked', 'Run create login.');
    }
    saveCredentials(apiUrl, { ...fresh, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: io.now() + (body.expires_in ?? 3600) * 1000 }, io.env);
    return body.access_token;
  });
}

/** Revoke the refresh token's family server-side (RFC 7009) and forget the sign-in. */
export async function logout(apiUrl: string, io: Pick<AuthIo, 'fetchImpl' | 'env'>): Promise<boolean> {
  const creds = loadCredentials(apiUrl, io.env);
  if (!creds) return false;
  await io.fetchImpl(`${apiUrl}/oauth/revoke`, form({ token: creds.refreshToken, token_type_hint: 'refresh_token', client_id: creds.clientId })).catch(() => undefined);
  clearCredentials(apiUrl, io.env);
  return true;
}
