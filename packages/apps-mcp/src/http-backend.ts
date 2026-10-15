import type { AiEstimateInfo, AiEstimateInput, AiGatewayInfo, AiGatewayRequestInfo, AiGatewaySettingsInput, AppsDeadLetter, AppsQueue, AppsQueueInput, AppsQueueMessageInput, AppsWorkflowRun, BlobList, BlobMultipartInput, BlobMultipartUpload, BlobPartUrls, BlobStore, BlobStoreInput, BlobUploadUrl, BlobUploadUrlInput } from './backend.js';
import type { ComposeApplied, ComposeImportInput, ComposePreview, DomainList, DomainRegistration, EdgeSettings, EdgeSettingsChange, FirewallChange, FirewallMatches, FirewallRule, FirewallRuleInput, FirewallSettings, Sandbox, SandboxCommand, SandboxExecInput, SandboxExecResult, SandboxFile, SandboxFileEntry, SandboxInput, SandboxPortUrl, SandboxSnapshot, ReviewNotice, ScalingChange, ServiceScaling, ServiceWake, StaticEgress } from './backend.js';
import type { PreviewCommentQuery, PreviewCommentThread, ProtectionChange, ProtectionSettings, ShareLink, ShareLinkCreated, ShareLinkInput, BillingPlanChange, BillingPlanView, BillingUsage, InvoicePreview, AnalyticsRangeQuery, AnalyticsReport, AnalyticsSettings, SpeedInsightsReport, AnonymousBackend, AnonymousDeploy, AnonymousDeployCreated, AppsBackend, ClaimedDeployment, DeployAccepted, Deployment, EdgeDeployAccepted, EdgeHostname, EdgePreview, EdgeUsage, PromoteAccepted, GitHubConnectInput, ImageSettings, GitHubLink, LogLine, LogQueryInput, MetricName, MetricSeries, Preview, Project, ProjectListItem, Service, ServiceSpec, SourceDeployOptions, UploadTicket, Variable, VariableChange, Whoami } from './backend.js';
import type { Database, DatabaseBackup, DatabaseConnectSession, DatabasePatch, DatabaseSpec } from './backend.js';
import type { Valkey, ValkeyBackup, ValkeyInput, Volume, VolumeInput, VolumeSnapshot } from './backend.js';
import type { DatabaseEdgeAccess, PrivateKeyRotation, PrivateNetworking, ServiceVisibilityResult } from './backend.js';
import type { ProjectImport, VercelImportApplied, VercelImportInput, VercelImportPreview, VercelProjectSummary } from './backend.js';
import type { AlertChannel, AlertChannelInput, AlertRule, AlertRuleChange, AlertRuleInput, AlertsOverview } from './backend.js';
import type { ApexDomain, ApexDomainInput } from './backend.js';
import { AgentError, fixFor } from './errors.js';

/**
 * `AppsBackend` over the Admin API (`/v1/apps/*`) with a `cat_` token — what the `create` CLI and
 * `create mcp` (stdio) use. Every non-2xx answer becomes an AgentError carrying the API's stable code
 * and, when the API sent one, its `fix`.
 *
 * Upload and Git deploys call slice A3's endpoints as the spec defines them (§6, §8.3):
 * `POST /v1/apps/uploads { projectId, sizeBytes, sha256 }` → a pre-signed PUT, then (E2)
 * `POST /v1/apps/projects/{id}/source-deployments { service, source, target }`, where the control
 * plane's framework detector picks the edge or a container and creates the service when missing. A
 * deployment without A3 answers 404 on `/v1/apps/uploads`, which this reports as `not_available_yet`
 * rather than a confusing "not found".
 */

export type HttpBackendOptions = {
  apiUrl: string;
  /** The current access token; called before every request so a refresh in between is picked up. */
  token: () => Promise<string>;
  /** Called once on a 401 `invalid_token`; returns a fresh token, or null when signing in again is the only way. */
  refresh?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  userAgent?: string;
};

type ApiErrorBody = { error?: string; message?: string; fix?: string; docs_url?: string; [detail: string]: unknown };

export class HttpAppsBackend implements AppsBackend {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpBackendOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retried = false): Promise<T> {
    // A FormData body (the edge bundle upload) goes as multipart; fetch sets its boundary header.
    const multipart = body instanceof FormData;
    const res = await this.fetchImpl(`${this.opts.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.opts.token()}`,
        accept: 'application/json',
        ...(body === undefined || multipart ? {} : { 'content-type': 'application/json' }),
        ...(this.opts.userAgent ? { 'user-agent': this.opts.userAgent } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    if (res.status === 401 && !retried && this.opts.refresh) {
      const fresh = await this.opts.refresh();
      if (fresh) return this.request<T>(method, path, body, headers, true);
    }
    const text = await res.text();
    if (!res.ok) throw this.toError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private toError(status: number, text: string, path: string): AgentError {
    let body: ApiErrorBody = {};
    try {
      body = JSON.parse(text) as ApiErrorBody;
    } catch {
      body = {};
    }
    if (status === 404 && (path.startsWith('/v1/apps/uploads') || !body.error || body.error === 'not_found')) {
      if (path.startsWith('/v1/apps/uploads') || (path.includes('/logs') && !path.includes('/logs/stream'))) {
        return new AgentError('not_available_yet', 'This Create deployment does not accept uploads or serve logs yet', 'Deploy a container image with `create deploy --image <ref>` (or deploy_image) instead.', { status });
      }
    }
    const code = body.error ?? (status === 401 ? 'invalid_token' : status === 429 ? 'rate_limited' : `http_${status}`);
    const message = body.message ?? `The Create API answered ${status}`;
    return new AgentError(code, message, body.fix ?? fixFor(code, body), { status, docsUrl: body.docs_url });
  }

  whoami() {
    return this.request<Whoami>('GET', '/v1/apps/whoami');
  }
  async listProjects() {
    return (await this.request<{ projects: ProjectListItem[] }>('GET', '/v1/apps/projects')).projects;
  }
  getProject(projectId: string) {
    return this.request<Project>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}`);
  }
  async createProject(input: { name: string; region: string; idempotencyKey: string; edgeOnly?: boolean }) {
    const me = await this.whoami();
    const accountId = me.grant?.accountId ?? me.accounts.find((a) => a.capabilities.includes('apps.configure'))?.accountId;
    if (!accountId) throw new AgentError('missing_capability', 'This sign-in cannot create projects in any account', fixFor('missing_capability'));
    return this.request<Project>('POST', '/v1/apps/projects', { accountId, name: input.name, region: input.region, ...(input.edgeOnly ? { edgeOnly: true } : {}) }, { 'idempotency-key': input.idempotencyKey });
  }
  async listDeployments(serviceId: string) {
    return (await this.request<{ deployments: Deployment[] }>('GET', `/v1/apps/services/${encodeURIComponent(serviceId)}/deployments`)).deployments;
  }
  getDeployment(deploymentId: string) {
    return this.request<Deployment>('GET', `/v1/apps/deployments/${encodeURIComponent(deploymentId)}`);
  }
  createService(projectId: string, spec: ServiceSpec & { image: string }, idempotencyKey: string) {
    return this.request<Service>(
      'POST',
      `/v1/apps/projects/${encodeURIComponent(projectId)}/services`,
      { name: spec.name, kind: spec.kind, image: spec.image, size: spec.size, replicas: spec.replicas, ...(spec.kind === 'web' ? { port: spec.port ?? 8080 } : {}) },
      { 'idempotency-key': idempotencyKey },
    );
  }
  updateService(serviceId: string, patch: { size?: string; replicas?: number; port?: number | null; image?: string }) {
    return this.request<Service>('PATCH', `/v1/apps/services/${encodeURIComponent(serviceId)}`, patch);
  }
  deployImage(serviceId: string, image: string, idempotencyKey: string) {
    return this.request<DeployAccepted>('POST', `/v1/apps/services/${encodeURIComponent(serviceId)}/deployments`, { image }, { 'idempotency-key': idempotencyKey });
  }
  rollback(deploymentId: string, idempotencyKey: string) {
    return this.request<DeployAccepted>('POST', `/v1/apps/deployments/${encodeURIComponent(deploymentId)}/rollback`, undefined, { 'idempotency-key': idempotencyKey });
  }
  async setVariables(environmentId: string, change: VariableChange) {
    const res = await this.request<{ variables: { key: string; secret: boolean; serviceId: string | null }[] }>('PUT', `/v1/apps/environments/${encodeURIComponent(environmentId)}/variables`, change);
    return res.variables.map((v) => ({ key: v.key, secret: v.secret, serviceId: v.serviceId }));
  }
  deleteProject(projectId: string, confirm: string) {
    return this.request<{ project: Project }>('DELETE', `/v1/apps/projects/${encodeURIComponent(projectId)}?confirm=${encodeURIComponent(confirm)}`);
  }
  async logs(serviceId: string, input: LogQueryInput) {
    return (await this.logsPage(serviceId, input)).lines;
  }
  /** A7: one page of logs with the cursor for older lines (`create logs --since`). */
  logsPage(serviceId: string, input: LogQueryInput & { cursor?: string | null }) {
    const q = new URLSearchParams({ type: input.type, lines: String(input.lines) });
    if (input.deploymentId) q.set('deploymentId', input.deploymentId);
    if (input.from) q.set('from', input.from);
    if (input.to) q.set('to', input.to);
    if (input.q) q.set('q', input.q);
    if (input.level) q.set('level', input.level);
    if (input.cursor) q.set('cursor', input.cursor);
    return this.request<{ lines: LogLine[]; nextCursor: string | null }>('GET', `/v1/apps/services/${encodeURIComponent(serviceId)}/logs?${q}`);
  }
  metrics(serviceId: string, input: { metric: MetricName; from?: string | null; to?: string | null; step?: number | null }) {
    const q = new URLSearchParams({ metric: input.metric });
    if (input.from) q.set('from', input.from);
    if (input.to) q.set('to', input.to);
    if (input.step) q.set('step', String(input.step));
    return this.request<MetricSeries>('GET', `/v1/apps/services/${encodeURIComponent(serviceId)}/metrics?${q}`);
  }
  /**
   * A7: follow a service's runtime logs (SSE). Calls `onLine` for each line until the server ends the
   * stream (it answers with the reason) or `signal` aborts (null). A 401 refreshes the token once.
   */
  async followLogs(serviceId: string, input: { q?: string | null; level?: string | null }, onLine: (line: LogLine) => void, signal?: AbortSignal, onDropped?: (count: number) => void): Promise<string | null> {
    const q = new URLSearchParams();
    if (input.q) q.set('q', input.q);
    if (input.level) q.set('level', input.level);
    const url = `${this.opts.apiUrl.replace(/\/$/, '')}/v1/apps/services/${encodeURIComponent(serviceId)}/logs/stream${q.size ? `?${q}` : ''}`;
    const open = async () =>
      this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${await this.opts.token()}`, accept: 'text/event-stream', ...(this.opts.userAgent ? { 'user-agent': this.opts.userAgent } : {}) }, signal });
    let res = await open();
    if (res.status === 401 && this.opts.refresh && (await this.opts.refresh())) res = await open();
    if (!res.ok || !res.body) throw this.toError(res.status, await res.text().catch(() => ''), url);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        buffered += decoder.decode(value, { stream: true });
        let sep = buffered.indexOf('\n\n');
        while (sep >= 0) {
          const block = buffered.slice(0, sep);
          buffered = buffered.slice(sep + 2);
          const event = /^event: ?(.*)$/m.exec(block)?.[1]?.trim() ?? 'message';
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (event === 'line' && data) onLine(JSON.parse(data) as LogLine);
          else if (event === 'dropped' && data) onDropped?.((JSON.parse(data) as { count: number }).count);
          else if (event === 'end') return data ? ((JSON.parse(data) as { reason?: string }).reason ?? 'end') : 'end';
          sep = buffered.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ A3 seam (spec §6, §8.3)
  createUpload(projectId: string, sizeBytes: number, sha256: string) {
    return this.request<UploadTicket>('POST', '/v1/apps/uploads', { projectId, sizeBytes, sha256 });
  }
  async storeUpload(projectId: string, tarball: Uint8Array, sha256: string) {
    const ticket = await this.createUpload(projectId, tarball.length, sha256);
    if (tarball.length > ticket.maxBytes) throw new AgentError('upload_too_large', `The package is ${tarball.length} bytes, over the ${ticket.maxBytes}-byte limit`, 'Add large build outputs and assets to .createignore, or deploy a container image instead.');
    // The pre-signed URL carries its own authorization: our bearer token is never sent to object storage.
    const put = await this.fetchImpl(ticket.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/gzip', ...ticket.headers }, body: tarball as unknown as NonNullable<RequestInit['body']> });
    if (!put.ok) throw new AgentError('upload_failed', `Uploading the package failed (${put.status})`, 'Retry the deploy; if it keeps failing, check your network connection.');
    return { uploadId: ticket.uploadId };
  }
  /** E2: one entry point for deploys from source; the answer says edge or container, and why. */
  private deploySource(projectId: string, spec: ServiceSpec, source: Record<string, unknown>, idempotencyKey: string, options: SourceDeployOptions = {}) {
    return this.request<DeployAccepted>(
      'POST',
      `/v1/apps/projects/${encodeURIComponent(projectId)}/source-deployments`,
      {
        service: { name: spec.name, kind: spec.kind, size: spec.size, replicas: spec.replicas, ...(spec.kind === 'web' ? { port: spec.port ?? 8080 } : {}) },
        source,
        target: options.target ?? 'auto',
        ...(options.framework ? { framework: options.framework } : {}),
        ...(options.preview ? { preview: { branch: options.preview.branch } } : {}),
      },
      { 'idempotency-key': idempotencyKey },
    );
  }
  deployUpload(projectId: string, spec: ServiceSpec, uploadId: string, idempotencyKey: string, options?: SourceDeployOptions) {
    return this.deploySource(projectId, spec, { type: 'upload', uploadId }, idempotencyKey, options);
  }
  // ------------------------------------------------------------------ E1 edge tier (spec §7)
  deployEdgeBundle(projectId: string, service: string, tarball: Uint8Array, idempotencyKey: string, options: { preview?: { branch: string | null } | null } = {}) {
    const form = new FormData();
    form.append('bundle', new Blob([tarball as unknown as ArrayBuffer], { type: 'application/gzip' }), 'bundle.tar.gz');
    form.append('service', service);
    if (options.preview) {
      form.append('preview', 'true');
      if (options.preview.branch) form.append('branch', options.preview.branch);
    }
    return this.request<EdgeDeployAccepted>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/edge-deployments`, form, { 'idempotency-key': idempotencyKey });
  }
  attachHostname(serviceId: string, hostname: string) {
    return this.request<EdgeHostname>('POST', `/v1/apps/services/${encodeURIComponent(serviceId)}/hostnames`, { hostname });
  }
  verifyHostname(hostnameId: string) {
    return this.request<EdgeHostname>('POST', `/v1/apps/hostnames/${encodeURIComponent(hostnameId)}/verify`);
  }
  // ------------------------------------------------------------------ A4 domains and variables (CLI)
  async listVariables(environmentId: string) {
    return (await this.request<{ variables: Variable[] }>('GET', `/v1/apps/environments/${encodeURIComponent(environmentId)}/variables`)).variables;
  }
  async listHostnames(serviceId: string) {
    return (await this.request<{ hostnames: EdgeHostname[] }>('GET', `/v1/apps/services/${encodeURIComponent(serviceId)}/hostnames`)).hostnames;
  }
  removeHostname(hostnameId: string) {
    return this.request<{ removed: boolean }>('DELETE', `/v1/apps/hostnames/${encodeURIComponent(hostnameId)}`);
  }
  // ------------------------------------------------------------------ apex gateway (bare domains)
  async listApexDomains(serviceId: string) {
    return (await this.request<{ apexDomains: ApexDomain[] }>('GET', `/v1/apps/services/${encodeURIComponent(serviceId)}/apex-domains`)).apexDomains;
  }
  addApexDomain(serviceId: string, input: ApexDomainInput) {
    return this.request<ApexDomain>('POST', `/v1/apps/services/${encodeURIComponent(serviceId)}/apex-domains`, input);
  }
  verifyApexDomain(apexId: string) {
    return this.request<ApexDomain>('POST', `/v1/apps/apex-domains/${encodeURIComponent(apexId)}/verify`);
  }
  removeApexDomain(apexId: string) {
    return this.request<{ removed: boolean }>('DELETE', `/v1/apps/apex-domains/${encodeURIComponent(apexId)}`);
  }
  // ------------------------------------------------------------------ E7 protected previews
  getProtection(projectId: string) {
    return this.request<ProtectionSettings>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/protection`);
  }
  setProtection(projectId: string, change: ProtectionChange) {
    return this.request<ProtectionSettings>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/protection`, change);
  }
  setProtectionPassword(projectId: string, password: string | null) {
    const path = `/v1/apps/projects/${encodeURIComponent(projectId)}/protection/password`;
    return password === null ? this.request<ProtectionSettings>('DELETE', path) : this.request<ProtectionSettings>('PUT', path, { password });
  }
  revokeProtectionSessions(projectId: string) {
    return this.request<ProtectionSettings>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/protection/revoke-sessions`);
  }
  async listShareLinks(projectId: string) {
    return (await this.request<{ links: ShareLink[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/protection/links`)).links;
  }
  createShareLink(projectId: string, input: ShareLinkInput) {
    return this.request<ShareLinkCreated>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/protection/links`, input);
  }
  async revokeShareLink(projectId: string, linkId: string) {
    return (await this.request<{ link: ShareLink }>('DELETE', `/v1/apps/projects/${encodeURIComponent(projectId)}/protection/links/${encodeURIComponent(linkId)}`)).link;
  }

  // ------------------------------------------------------------------ A10 compose import
  previewCompose(projectId: string, input: ComposeImportInput) {
    return this.request<ComposePreview>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/compose/preview`, input);
  }
  applyCompose(projectId: string, input: ComposeImportInput & { planHash: string }, idempotencyKey: string) {
    return this.request<ComposeApplied>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/compose/apply`, input, { 'idempotency-key': idempotencyKey });
  }

  // ------------------------------------------------------------------ moving from Vercel
  async listVercelProjects(connectionId: string) {
    return (await this.request<{ projects: VercelProjectSummary[] }>('GET', `/v1/apps/vercel/connections/${encodeURIComponent(connectionId)}/projects`)).projects;
  }
  previewVercelImport(projectId: string, input: VercelImportInput) {
    return this.request<VercelImportPreview>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/vercel/preview`, input);
  }
  applyVercelImport(projectId: string, input: VercelImportInput & { planHash: string }, idempotencyKey: string) {
    return this.request<VercelImportApplied>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/vercel/apply`, input, { 'idempotency-key': idempotencyKey });
  }
  getImportStatus(importId: string) {
    return this.request<ProjectImport>('GET', `/v1/apps/imports/${encodeURIComponent(importId)}`);
  }

  // ------------------------------------------------------------------ X1 sandboxes
  async createSandbox(projectId: string, input: SandboxInput) {
    return (await this.request<{ sandbox: Sandbox }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/sandboxes`, input)).sandbox;
  }
  async listSandboxes(projectId: string, includeEnded: boolean) {
    return (await this.request<{ sandboxes: Sandbox[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/sandboxes${includeEnded ? '?all=true' : ''}`)).sandboxes;
  }
  execSandbox(sandboxId: string, input: SandboxExecInput) {
    return this.request<SandboxExecResult>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/exec`, input);
  }
  writeSandboxFile(sandboxId: string, path: string, contentBase64: string, mode?: number) {
    return this.request<{ command: SandboxCommand }>('PUT', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/files`, { path, contentBase64, ...(mode !== undefined ? { mode } : {}) });
  }
  readSandboxFile(sandboxId: string, path: string) {
    return this.request<SandboxFile>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/files/read`, { path });
  }
  listSandboxFiles(sandboxId: string, path?: string) {
    return this.request<{ entries: SandboxFileEntry[]; truncated: boolean }>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/files/list`, path ? { path } : {});
  }
  exposeSandboxPort(sandboxId: string, port: number, ttlSeconds?: number) {
    return this.request<SandboxPortUrl>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/ports`, { port, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) });
  }
  snapshotSandbox(sandboxId: string, name?: string) {
    return this.request<{ snapshot: SandboxSnapshot; command: SandboxCommand }>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, name ? { name } : {});
  }
  async listSandboxSnapshots(projectId: string) {
    return (await this.request<{ snapshots: SandboxSnapshot[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/sandbox-snapshots`)).snapshots;
  }
  stopSandbox(sandboxId: string) {
    return this.request<Sandbox>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/stop`);
  }
  extendSandbox(sandboxId: string, addSeconds: number) {
    return this.request<Sandbox>('POST', `/v1/apps/sandboxes/${encodeURIComponent(sandboxId)}/extend`, { addSeconds });
  }
  async deleteSandboxSnapshot(snapshotId: string) {
    await this.request<unknown>('DELETE', `/v1/apps/sandbox-snapshots/${encodeURIComponent(snapshotId)}`);
  }

  // ------------------------------------------------------------------ N1 firewall and static egress
  getFirewall(projectId: string) {
    return this.request<FirewallSettings>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/firewall`);
  }
  getFirewallMatches(projectId: string, hours?: number) {
    return this.request<FirewallMatches>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/firewall/matches${hours !== undefined ? `?hours=${encodeURIComponent(String(hours))}` : ''}`);
  }
  setFirewall(projectId: string, change: FirewallChange) {
    return this.request<FirewallSettings>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/firewall`, change);
  }
  addFirewallRule(projectId: string, rule: FirewallRuleInput, position?: number) {
    return this.request<{ rule: FirewallRule; firewall: FirewallSettings }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/firewall/rules`, { rule, ...(position !== undefined ? { position } : {}) });
  }
  deleteFirewallRule(projectId: string, ruleId: string) {
    return this.request<FirewallSettings>('DELETE', `/v1/apps/projects/${encodeURIComponent(projectId)}/firewall/rules/${encodeURIComponent(ruleId)}`);
  }
  wakeService(serviceId: string) {
    return this.request<ServiceWake>('POST', `/v1/apps/services/${encodeURIComponent(serviceId)}/wake`);
  }
  getReviewNotice(projectId: string) {
    return this.request<ReviewNotice>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/abuse`);
  }
  getScaling(serviceId: string) {
    return this.request<ServiceScaling>('GET', `/v1/apps/services/${encodeURIComponent(serviceId)}/scaling`);
  }
  setScaling(serviceId: string, change: ScalingChange) {
    return this.request<{ scaling: ServiceScaling; deployment: DeployAccepted | null }>('PUT', `/v1/apps/services/${encodeURIComponent(serviceId)}/scaling`, change);
  }
  getEgress(projectId: string) {
    return this.request<StaticEgress>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/egress`);
  }
  setEgress(projectId: string, enabled: boolean) {
    return this.request<StaticEgress>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/egress`, { enabled });
  }

  // ------------------------------------------------------------------ E7b preview comments
  async listComments(projectId: string, query: PreviewCommentQuery) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return (await this.request<{ threads: PreviewCommentThread[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/comments${qs ? `?${qs}` : ''}`)).threads;
  }
  async replyComment(projectId: string, threadId: string, body: string) {
    return (await this.request<{ thread: PreviewCommentThread }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(threadId)}/replies`, { body })).thread;
  }
  async setCommentStatus(projectId: string, threadId: string, status: 'open' | 'resolved') {
    return (await this.request<{ thread: PreviewCommentThread }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(threadId)}/${status === 'resolved' ? 'resolve' : 'reopen'}`)).thread;
  }

  // ------------------------------------------------------------------ E4 private networking
  getPrivateNetworking(projectId: string) {
    return this.request<PrivateNetworking>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/private-networking`);
  }
  setServiceVisibility(serviceId: string, visibility: 'public' | 'project') {
    return this.request<ServiceVisibilityResult>('PUT', `/v1/apps/services/${encodeURIComponent(serviceId)}/visibility`, { visibility });
  }
  rotatePrivateKeys(projectId: string, emergency: boolean) {
    return this.request<PrivateKeyRotation>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/private-networking/keys/rotate`, emergency ? { emergency: true } : {});
  }
  setDatabaseEdgeAccess(databaseId: string, action: 'enable' | 'disable' | 'rotate') {
    const path = `/v1/apps/databases/${encodeURIComponent(databaseId)}/edge-access${action === 'rotate' ? '/rotate' : ''}`;
    return this.request<{ database: DatabaseEdgeAccess; changed: boolean }>(action === 'disable' ? 'DELETE' : 'POST', path);
  }

  // ------------------------------------------------------------------ E6 Web Analytics + Speed Insights
  getAnalyticsSettings(projectId: string) {
    return this.request<AnalyticsSettings>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/analytics/settings`);
  }
  setAnalytics(projectId: string, enabled: boolean) {
    return this.request<AnalyticsSettings>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/analytics/settings`, { enabled });
  }
  getAnalytics(projectId: string, query: AnalyticsRangeQuery) {
    return this.request<AnalyticsReport>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/analytics${rangeQuery(query)}`);
  }
  getSpeedInsights(projectId: string, query: AnalyticsRangeQuery) {
    return this.request<SpeedInsightsReport>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/speed-insights${rangeQuery({ from: query.from, to: query.to })}`);
  }
  // ------------------------------------------------------------------ A8 plans, usage, spending limits
  getBillingUsage(query: { accountId?: string; month?: string }) {
    return this.request<BillingUsage>('GET', `/v1/apps/billing/usage${rangeQuery(query)}`);
  }
  getBillingPlan(accountId?: string) {
    return this.request<BillingPlanView>('GET', `/v1/apps/billing/plan${rangeQuery({ accountId })}`);
  }
  setPlan(input: { accountId?: string; plan: 'free' | 'pro' | 'team' }) {
    return this.request<BillingPlanChange>('PUT', '/v1/apps/billing/plan', input);
  }
  setSpendCap(input: { accountId?: string; enabled: boolean; amount?: number }) {
    return this.request<BillingPlanView>('PUT', '/v1/apps/billing/spend-cap', input);
  }
  getInvoicePreview(accountId?: string) {
    return this.request<InvoicePreview>('GET', `/v1/apps/billing/invoice-preview${rangeQuery({ accountId })}`);
  }
  /** A9: `PUT /v1/apps/projects/{id}/github` — connect a repository granted to the Create GitHub App. */
  connectGitHubRepo(projectId: string, input: GitHubConnectInput) {
    return this.request<{ link: GitHubLink; deploying: boolean }>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/github`, input);
  }
  /** A9: `GET /v1/apps/projects/{id}/previews`. */
  async listPreviews(projectId: string, includeClosed: boolean) {
    return (await this.request<{ previews: Preview[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/previews${includeClosed ? '?includeClosed=true' : ''}`)).previews;
  }
  deployGit(projectId: string, spec: ServiceSpec, repository: string, ref: string | null, idempotencyKey: string, options?: SourceDeployOptions) {
    return this.deploySource(projectId, spec, { type: 'git', repository, ...(ref ? { ref } : {}) }, idempotencyKey, options);
  }
  // ------------------------------------------------------------------ E3 previews, promotion, usage
  promote(deploymentId: string, idempotencyKey: string, options: { allowBuildTimeDrift?: boolean }) {
    return this.request<PromoteAccepted>('POST', `/v1/apps/deployments/${encodeURIComponent(deploymentId)}/promote`, options.allowBuildTimeDrift ? { allowBuildTimeDrift: true } : {}, { 'idempotency-key': idempotencyKey });
  }
  async listEdgePreviews(projectId: string, includeClosed: boolean) {
    return (await this.request<{ previews: EdgePreview[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/edge-previews${includeClosed ? '?includeClosed=true' : ''}`)).previews;
  }
  edgeUsage(projectId: string) {
    return this.request<EdgeUsage>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/edge-usage`);
  }
  getEdgeSettings(projectId: string) {
    return this.request<EdgeSettings>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/edge-settings`);
  }
  setEdgeSettings(projectId: string, change: EdgeSettingsChange) {
    return this.request<EdgeSettings>('PATCH', `/v1/apps/projects/${encodeURIComponent(projectId)}/edge-settings`, change);
  }
  // ------------------------------------------------------------------ D1 registered domains (read only)
  listDomains(accountId?: string) {
    return this.request<DomainList>('GET', `/v1/apps/domains${rangeQuery({ accountId })}`);
  }
  getDomain(name: string, accountId?: string) {
    return this.request<DomainRegistration>('GET', `/v1/apps/domains/${encodeURIComponent(name)}${rangeQuery({ accountId })}`);
  }
  // ------------------------------------------------------------------ A5 volumes and Valkey
  async listVolumes(projectId: string) {
    return (await this.request<{ volumes: Volume[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/volumes`)).volumes;
  }
  async addVolume(projectId: string, input: VolumeInput, idempotencyKey: string) {
    // A replay of an earlier create (same Idempotency-Key) answers the volume with no new operation.
    const r = await this.request<{ volume: Volume; operation: unknown }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/volumes`, input, { 'idempotency-key': idempotencyKey });
    return { volume: r.volume, created: r.operation !== null };
  }
  async snapshotVolume(volumeId: string) {
    return (await this.request<{ snapshot: VolumeSnapshot }>('POST', `/v1/apps/volumes/${encodeURIComponent(volumeId)}/snapshots`)).snapshot;
  }
  async backupValkey(valkeyId: string) {
    return (await this.request<{ backup: ValkeyBackup }>('POST', `/v1/apps/valkey/${encodeURIComponent(valkeyId)}/backups`)).backup;
  }
  async listValkeyBackups(valkeyId: string) {
    return (await this.request<{ backups: ValkeyBackup[] }>('GET', `/v1/apps/valkey/${encodeURIComponent(valkeyId)}/backups`)).backups;
  }
  // ------------------------------------------------------------------ A7 alerting
  getAlerts(projectId: string) {
    return this.request<AlertsOverview>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/alerts`);
  }
  async createAlertRule(projectId: string, input: AlertRuleInput) {
    return (await this.request<{ rule: AlertRule }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/alert-rules`, input)).rule;
  }
  async updateAlertRule(ruleId: string, change: AlertRuleChange) {
    return (await this.request<{ rule: AlertRule }>('PATCH', `/v1/apps/alert-rules/${encodeURIComponent(ruleId)}`, change)).rule;
  }
  deleteAlertRule(ruleId: string) {
    return this.request<{ removed: boolean }>('DELETE', `/v1/apps/alert-rules/${encodeURIComponent(ruleId)}`);
  }
  createAlertChannel(projectId: string, input: AlertChannelInput) {
    return this.request<{ channel: AlertChannel; signingSecret: string | null }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/alert-channels`, input);
  }
  deleteAlertChannel(channelId: string) {
    return this.request<{ removed: boolean }>('DELETE', `/v1/apps/alert-channels/${encodeURIComponent(channelId)}`);
  }
  testAlertChannel(channelId: string) {
    return this.request<{ notificationId: string }>('POST', `/v1/apps/alert-channels/${encodeURIComponent(channelId)}/test`);
  }
  async listValkey(projectId: string) {
    return (await this.request<{ valkey: Valkey[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/valkey`)).valkey;
  }
  async addValkey(projectId: string, input: ValkeyInput, idempotencyKey: string) {
    const r = await this.request<{ valkey: Valkey; operation: unknown }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/valkey`, input, { 'idempotency-key': idempotencyKey });
    return { valkey: r.valkey, created: r.operation !== null };
  }

  // ------------------------------------------------------------------ E5 image optimization
  getImageSettings(projectId: string) {
    return this.request<ImageSettings>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/images`);
  }
  setImageDomains(projectId: string, domains: string[]) {
    return this.request<ImageSettings>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/images/domains`, { domains });
  }
  // ------------------------------------------------------------------ X2 AI Gateway
  getAiGateway(projectId: string) {
    return this.request<AiGatewayInfo>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway`);
  }
  configureAiGateway(projectId: string, input: AiGatewaySettingsInput) {
    return this.request<AiGatewayInfo>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway`, input);
  }
  setAiGatewayTokenLimit(projectId: string, tokenId: string, monthlyLimitMicrousd: number | null) {
    return this.request<{ tokenInfo: AiGatewayInfo['tokens'][number] }>('PATCH', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/tokens/${encodeURIComponent(tokenId)}`, { monthlyLimitMicrousd });
  }
  createAiGatewayToken(projectId: string, input: { name: string; models?: string[]; monthlyLimitMicrousd?: number | null }) {
    return this.request<{ token: string; tokenInfo: AiGatewayInfo['tokens'][number] }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/tokens`, input);
  }
  revokeAiGatewayToken(projectId: string, tokenId: string) {
    return this.request<{ revoked: boolean }>('DELETE', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/tokens/${encodeURIComponent(tokenId)}`);
  }
  rotateAiGatewayToken(projectId: string, immediate: boolean) {
    return this.request<{ gateway: AiGatewayInfo; graceEndsAt: string | null }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/rotate`, { immediate });
  }
  estimateAiCost(projectId: string, input: AiEstimateInput) {
    return this.request<AiEstimateInfo>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/estimate`, input);
  }
  setAiProviderKey(projectId: string, provider: AiGatewayInfo['providerKeys'][number]['provider'], key: string) {
    return this.request<AiGatewayInfo>('PUT', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/provider-keys/${provider}`, { key });
  }
  removeAiProviderKey(projectId: string, provider: AiGatewayInfo['providerKeys'][number]['provider']) {
    return this.request<{ removed: boolean }>('DELETE', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/provider-keys/${provider}`);
  }
  listAiRequests(projectId: string, query: { model?: string; status?: AiGatewayRequestInfo['status'] }) {
    const q = new URLSearchParams();
    if (query.model) q.set('model', query.model);
    if (query.status) q.set('status', query.status);
    const qs = q.toString();
    return this.request<{ requests: AiGatewayRequestInfo[]; cursor: string | null }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/ai-gateway/requests${qs ? `?${qs}` : ''}`);
  }
  // ------------------------------------------------------------------ X3 Queues and Workflows
  createQueue(projectId: string, kind: 'queue' | 'workflow', input: AppsQueueInput) {
    const body: Record<string, unknown> = { ...input };
    if (kind === 'workflow') delete body.delivery;
    return this.request<AppsQueue>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/${kind === 'queue' ? 'queues' : 'workflows'}`, body);
  }
  async listQueues(projectId: string, kind: 'queue' | 'workflow') {
    const plural = kind === 'queue' ? 'queues' : 'workflows';
    return (await this.request<Record<string, AppsQueue[]>>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/${plural}`))[plural] ?? [];
  }
  sendQueueMessages(queueId: string, messages: AppsQueueMessageInput[]) {
    return this.request<{ messages: { id: string; deduplicated: boolean }[] }>('POST', `/v1/apps/queues/${encodeURIComponent(queueId)}/messages`, { messages });
  }
  listDeadLetters(queueId: string) {
    return this.request<{ deadLetters: AppsDeadLetter[]; cursor: string | null }>('GET', `/v1/apps/queues/${encodeURIComponent(queueId)}/dead-letters`);
  }
  redriveDeadLetters(queueId: string, ids: string[] | null) {
    return this.request<{ count: number }>('POST', `/v1/apps/queues/${encodeURIComponent(queueId)}/dead-letters/redrive`, ids ? { ids } : {});
  }
  async rotateQueueSecrets(kind: 'queue' | 'workflow', id: string, immediate: boolean) {
    const r = await this.request<Record<string, unknown>>('POST', `/v1/apps/${kind === 'queue' ? 'queues' : 'workflows'}/${encodeURIComponent(id)}/rotate`, { immediate });
    return { queue: r[kind] as AppsQueue, graceEndsAt: (r.graceEndsAt as string | null) ?? null };
  }
  deleteQueue(kind: 'queue' | 'workflow', id: string, confirm: string) {
    return this.request<{ removedMessages: number; removedRuns: number }>('DELETE', `/v1/apps/${kind === 'queue' ? 'queues' : 'workflows'}/${encodeURIComponent(id)}?confirm=${encodeURIComponent(confirm)}`);
  }
  addQueueSchedule(kind: 'queue' | 'workflow', id: string, input: { cron: string; payload?: unknown }) {
    return this.request<{ id: string; cron: string; nextRunAt: string }>('POST', `/v1/apps/${kind === 'queue' ? 'queues' : 'workflows'}/${encodeURIComponent(id)}/schedules`, input);
  }
  startWorkflowRun(workflowId: string, input: { input?: unknown; idempotencyKey?: string }) {
    return this.request<{ run: AppsWorkflowRun; created: boolean }>('POST', `/v1/apps/workflows/${encodeURIComponent(workflowId)}/runs`, input);
  }
  listWorkflowRuns(workflowId: string, status?: AppsWorkflowRun['status']) {
    return this.request<{ runs: AppsWorkflowRun[]; cursor: string | null }>('GET', `/v1/apps/workflows/${encodeURIComponent(workflowId)}/runs${status ? `?status=${status}` : ''}`);
  }
  getWorkflowRun(workflowId: string, runId: string) {
    return this.request<AppsWorkflowRun>('GET', `/v1/apps/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`);
  }
  workflowRunAction(workflowId: string, runId: string, action: 'cancel' | 'retry') {
    return this.request<AppsWorkflowRun>('POST', `/v1/apps/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/${action}`);
  }
  // ------------------------------------------------------------------ S1 Create Blob
  createBlobStore(projectId: string, input: BlobStoreInput) {
    return this.request<{ store: BlobStore; environments: number }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/blob-stores`, input);
  }
  async listBlobStores(projectId: string) {
    return (await this.request<{ stores: BlobStore[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/blob-stores`)).stores;
  }
  listBlobs(storeId: string, input: { prefix?: string; cursor?: string; limit?: number; mode?: 'expanded' | 'folded' }) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') q.set(k, String(v));
    const qs = q.toString();
    return this.request<BlobList>('GET', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/blobs${qs ? `?${qs}` : ''}`);
  }
  deleteBlobs(storeId: string, pathnames: string[]) {
    return this.request<{ deleted: string[]; notFound: string[] }>('POST', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/blobs/delete`, { pathnames });
  }
  rotateBlobToken(storeId: string) {
    return this.request<{ store: BlobStore; environments: number }>('POST', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/rotate-token`);
  }
  createBlobUploadUrl(storeId: string, input: BlobUploadUrlInput) {
    return this.request<BlobUploadUrl>('POST', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/upload-urls`, input);
  }
  createBlobMultipartUpload(storeId: string, input: BlobMultipartInput) {
    return this.request<BlobMultipartUpload>('POST', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/multipart-uploads`, input);
  }
  createBlobPartUrls(storeId: string, uploadId: string, input: { parts: { partNumber: number; size: number }[]; complete?: boolean; expiresIn?: number }) {
    return this.request<BlobPartUrls>('POST', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/multipart-uploads/${encodeURIComponent(uploadId)}/part-urls`, input);
  }
  abortBlobMultipartUpload(storeId: string, uploadId: string) {
    return this.request<{ uploadId: string; aborted: boolean }>('POST', `/v1/apps/blob-stores/${encodeURIComponent(storeId)}/multipart-uploads/${encodeURIComponent(uploadId)}/abort`);
  }
  // ------------------------------------------------------------------ A6 managed Postgres
  createDatabase(projectId: string, spec: DatabaseSpec, idempotencyKey: string) {
    return this.request<{ database: Database }>('POST', `/v1/apps/projects/${encodeURIComponent(projectId)}/databases`, spec, { 'idempotency-key': idempotencyKey });
  }
  async listDatabases(projectId: string) {
    return (await this.request<{ databases: Database[] }>('GET', `/v1/apps/projects/${encodeURIComponent(projectId)}/databases`)).databases;
  }
  getDatabase(databaseId: string) {
    return this.request<Database>('GET', `/v1/apps/databases/${encodeURIComponent(databaseId)}`);
  }
  updateDatabase(databaseId: string, patch: DatabasePatch) {
    return this.request<{ database: Database }>('PATCH', `/v1/apps/databases/${encodeURIComponent(databaseId)}`, patch);
  }
  listDatabaseBackups(databaseId: string) {
    return this.request<{ backups: DatabaseBackup[]; recoveryWindow: { from: string | null; to: string | null; pitr: boolean } }>('GET', `/v1/apps/databases/${encodeURIComponent(databaseId)}/backups`);
  }
  connectDatabase(databaseId: string, input: { minutes?: number; clientIp?: string }) {
    return this.request<DatabaseConnectSession>('POST', `/v1/apps/databases/${encodeURIComponent(databaseId)}/connect`, input);
  }
  // ------------------------------------------------------------------ P2 claim (spec §8.5)
  claimDeployment(token: string, options: { projectName?: string | null; accountId?: string | null }) {
    return this.request<ClaimedDeployment>('POST', '/v1/apps/anonymous-deploys/claim', { token, ...(options.projectName ? { projectName: options.projectName } : {}), ...(options.accountId ? { accountId: options.accountId } : {}) });
  }
}

/**
 * P2 (§8.5): the anonymous endpoints, with NO credentials at all — `create deploy --anonymous`. The
 * archive is the request body (`application/gzip`); the answer carries the claim link once.
 */
export class HttpAnonymousBackend implements AnonymousBackend {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: { apiUrl: string; fetchImpl?: typeof fetch; userAgent?: string }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: Uint8Array): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/gzip' } : {}), ...(this.opts.userAgent ? { 'user-agent': this.opts.userAgent } : {}) },
      body: body as unknown as NonNullable<RequestInit['body']> | undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: ApiErrorBody = {};
      try {
        parsed = JSON.parse(text) as ApiErrorBody;
      } catch {
        parsed = {};
      }
      const code = parsed.error ?? (res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_available_yet' : `http_${res.status}`);
      const message = parsed.message ?? (res.status === 404 ? 'Anonymous deploys are not available on this Create deployment' : `The Create API answered ${res.status}`);
      throw new AgentError(code, message, parsed.fix ?? (res.status === 404 ? 'Sign in (create login) and deploy to a project of your own.' : fixFor(code, parsed)), { status: res.status, docsUrl: parsed.docs_url });
    }
    return JSON.parse(text) as T;
  }

  deploy(tarball: Uint8Array) {
    return this.request<AnonymousDeployCreated>('POST', '/apps-anonymous/deploys', tarball);
  }
  status(id: string) {
    return this.request<AnonymousDeploy>('GET', `/apps-anonymous/deploys/${encodeURIComponent(id)}`);
  }
}

function rangeQuery(query: AnalyticsRangeQuery | Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (typeof v === 'string' && v) params.set(k, v);
  const q = params.toString();
  return q ? `?${q}` : '';
}
