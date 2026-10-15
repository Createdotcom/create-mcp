/**
 * The one error shape every hosting tool reports (spec §8.4 "Errors that tell an agent what to fix"):
 * a stable `code`, a one-line `message`, and a `fix` — one imperative sentence the model can act on.
 * Backends translate their own failures (an API error body, an HTTP status, a thrown ApiError) into
 * this; tools never let a raw stack or an HTTP body reach the model.
 */
export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
    readonly extra: { docsUrl?: string; missingScope?: string; status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AgentError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      fix: this.fix,
      ...(this.extra.docsUrl ? { docs_url: this.extra.docsUrl } : {}),
      ...(this.extra.missingScope ? { missing_scope: this.extra.missingScope } : {}),
    };
  }
}

/**
 * The grant lacks a scope the tool needs. Over streamable HTTP this becomes `403` with
 * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` (MCP 2026-07-28 "Scope Challenge
 * Handling") so the client can step up; over stdio it is an ordinary tool error.
 */
export class InsufficientScope extends AgentError {
  constructor(readonly requiredScopes: string[]) {
    super('insufficient_scope', `This connection is missing the ${requiredScopes.join(', ')} permission`, 'Reconnect Create and approve the extra permission, then retry.', { missingScope: requiredScopes.join(' ') });
  }
}

/** Default `fix` sentences for the API's stable error codes, used when the API did not send one. */
export const FIX_FOR_CODE: Record<string, string> = {
  project_not_found: 'Call list_projects to see the projects this connection can use.',
  service_not_found: 'Call get_project to see the project’s services and their ids.',
  deployment_not_found: 'Call get_project, then use a deployment id from one of its services.',
  environment_not_found: 'Call get_project to see the project’s environments.',
  account_not_found: 'Call get_usage to see which account this connection belongs to.',
  missing_capability: 'Ask an owner of the account to reconnect this app with the needed permission.',
  region_unavailable: 'Create the project in another region (omit region to use the default), or pass edge_only: true for a project that only receives prebuilt edge bundles.',
  project_name_taken: 'Pick a different project name, or call list_projects and deploy to the existing project.',
  service_name_taken: 'Use the existing service (see get_project) or pick a different service name.',
  idempotency_key_reused: 'Send a new idempotency_key, or omit it.',
  confirmation_mismatch: 'Pass confirm set to the project’s exact name.',
  project_not_active: 'This project is being deleted; create a new project instead.',
  not_rollbackable: 'Pick a deployment that has been live (status live or superseded).',
  already_current: 'That deployment is already serving; nothing to do.',
  not_cancellable: 'The deployment already started; wait for it with get_deployment.',
  port_not_applicable: 'Only web services listen on a port; omit port for workers.',
  spend_limit_reached: 'Use a smaller size or fewer replicas, or ask an account owner to raise this connection’s spend limit.',
  size_above_grant_ceiling: 'Use a smaller size, or ask an account owner to reconnect with a higher size ceiling.',
  grant_cannot_delete: 'Delete this project from the Create dashboard instead.',
  not_available_yet: 'Deploy a container image with deploy_image instead.',
  invalid_token: 'Reconnect Create (or run `create login`) to get a new token.',
  rate_limited: 'Wait a few seconds and retry.',
  invalid_request: 'Check the arguments against the tool’s input schema and retry.',
  edge_unavailable: 'Deploy the app as a container service for now (deploy_image, or a Dockerfile with deploy_files).',
  edge_bundle_required: 'Deploy the frontend with deploy_files or deploy_directory (a folder with create-edge.json), not deploy_image.',
  not_applicable_to_frontend: 'Deploy a new edge bundle to change a frontend; its limits come from the project plan.',
  service_kind_mismatch: 'Deploy the edge bundle under a different service name (for example "frontend").',
  hostname_taken: 'Remove the hostname from the other app first, or use a different hostname.',
  invalid_hostname: 'Pass a hostname like www.example.com, without https:// or a path.',
  apps_not_enabled: 'App hosting is not enabled for this account yet — ask Create to add it to the allowlist.',
};

/**
 * The `fix` for an API error code. `details` is the API error body (or an ApiError's details): where a
 * fix is better with a value from it — the account id the allowlist refused — it is used.
 */
export function fixFor(code: string, details?: Record<string, unknown>): string {
  const accountId = details?.accountId;
  if (code === 'apps_not_enabled' && typeof accountId === 'string' && accountId) {
    return `App hosting is not enabled for account ${accountId} yet — ask Create to add it to the allowlist.`;
  }
  return FIX_FOR_CODE[code] ?? 'Check the arguments and retry; if it keeps failing, report the error code to the person you are working with.';
}
