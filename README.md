# Create.com MCP servers

Deploy apps and run your online store on [Create.com](https://www.create.com) from any AI assistant or editor that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

Both servers are **remote** (streamable HTTP) and sign you in with **OAuth** on first use: nothing to install, no key to paste.

| Server | URL | What it does |
|---|---|---|
| **Create app hosting** (`create`) | `https://mcp.create.com/apps` | Create projects; deploy files, container images or Git repositories; attach domains; set write-only secrets; add Postgres; read logs, metrics and failure summaries; roll back. You choose which projects it may touch, a monthly spend limit and a size ceiling when you connect. |
| **Create Commerce** (`create-commerce`) | `https://mcp.create.com/commerce` | Work in one Create store: products, variants, collections, stock across locations, orders, returns, customers, draft orders with a link to your own checkout, pages, posts, navigation and theme. No tool refunds, cancels, pays out or issues gift cards. |

Registry names: `com.create/apps`, `com.create/commerce` ([MCP Registry](https://registry.modelcontextprotocol.io)).

## Install

### One click

| | App hosting | Commerce |
|---|---|---|
| Cursor | [![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=create&config=eyJ1cmwiOiJodHRwczovL21jcC5jcmVhdGUuY29tL2FwcHMifQ%3D%3D) | [![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=create-commerce&config=eyJ1cmwiOiJodHRwczovL21jcC5jcmVhdGUuY29tL2NvbW1lcmNlIn0%3D) |
| VS Code | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=create&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.create.com%2Fapps%22%7D) | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=create-commerce&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.create.com%2Fcommerce%22%7D) |
| VS Code Insiders | [Install](https://insiders.vscode.dev/redirect/mcp/install?name=create&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.create.com%2Fapps%22%7D&quality=insiders) | [Install](https://insiders.vscode.dev/redirect/mcp/install?name=create-commerce&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.create.com%2Fcommerce%22%7D&quality=insiders) |
| LM Studio | `lmstudio://add_mcp?name=create&config=eyJ1cmwiOiJodHRwczovL21jcC5jcmVhdGUuY29tL2FwcHMifQ%3D%3D` | `lmstudio://add_mcp?name=create-commerce&config=eyJ1cmwiOiJodHRwczovL21jcC5jcmVhdGUuY29tL2NvbW1lcmNlIn0%3D` |
| Gemini CLI | `gemini extensions install https://github.com/createdotcom/gemini-cli-extension` | (same extension) |

### Claude

- **claude.ai / Claude Desktop**: Settings → Connectors → *Add custom connector* → paste the URL → Connect.
- **Claude Code**: `claude mcp add --transport http create https://mcp.create.com/apps` (or `create-commerce https://mcp.create.com/commerce`), then `/mcp` → Authenticate.

### Local folders (the `create` CLI)

The remote servers take files, an uploaded tarball or a Git repository. To let a coding agent push the folder it is working in — building on your machine when needed — run the CLI's local MCP server instead:

```bash
claude mcp add create -- npx -y @createdotcom/cli mcp --local-builds   # Claude Code
codex mcp add create -- npx -y @createdotcom/cli mcp --local-builds    # Codex
```

Then ask: "push this to Create". Sign in once with `npx @createdotcom/cli login`.

### ChatGPT

Settings → Apps & Connectors → Advanced → Developer mode on → *Create app* → paste the URL, authentication **OAuth**.

### Grok (grok.com)

grok.com/connectors → **New Connector** → **Custom** → paste the URL → sign in to Create when asked. (Grok Business/Enterprise: a team admin adds it first in console.x.ai → Grok Business → Connectors.)

### Mistral Le Chat

Intelligence → Connectors → **Add Connector** → *Custom MCP Connector* → paste the URL → Connect (OAuth).

### Perplexity (Pro, Max, Enterprise)

Settings → Connectors → *Add custom connector* → name *Create*, the URL, transport *Streamable HTTP*, authentication OAuth.

### Microsoft Copilot Studio

Your agent → **Tools → Add a tool → New tool → Model Context Protocol** → server name *Create*, the URL, authentication **OAuth 2.0 → Dynamic discovery**.

### Config files (everything else)

Most clients take the same shape; only the key names differ.

```jsonc
// Cursor ~/.cursor/mcp.json · Claude Desktop (via connectors) · LM Studio mcp.json · JetBrains AI Assistant
{ "mcpServers": { "create": { "url": "https://mcp.create.com/apps" } } }

// VS Code .vscode/mcp.json
{ "servers": { "create": { "type": "http", "url": "https://mcp.create.com/apps" } } }

// Windsurf ~/.codeium/windsurf/mcp_config.json
{ "mcpServers": { "create": { "serverUrl": "https://mcp.create.com/apps" } } }

// Kiro .kiro/settings/mcp.json · Amazon Q Developer CLI
{ "mcpServers": { "create": { "type": "http", "url": "https://mcp.create.com/apps" } } }

// Zed settings.json
{ "context_servers": { "create": { "url": "https://mcp.create.com/apps" } } }

// Cline cline_mcp_settings.json
{ "mcpServers": { "create": { "type": "streamableHttp", "url": "https://mcp.create.com/apps" } } }

// Gemini CLI ~/.gemini/settings.json
{ "mcpServers": { "create": { "httpUrl": "https://mcp.create.com/apps" } } }
```

```yaml
# Continue (.continue/mcpServers/create.yaml)
name: Create
version: 0.1.0
schema: v1
mcpServers:
  - name: Create
    type: streamable-http
    url: https://mcp.create.com/apps
```

- **Open WebUI** (0.6.31+): Admin Settings → Integrations → External Tool Servers → **+ Add Connection** → type *MCP (Streamable HTTP)* → the URL → auth OAuth 2.1.
- **Warp**: Settings → AI → MCP servers → **+ Add** → paste `{ "create": { "url": "https://mcp.create.com/apps" } }`.
- **Ollama / Jan / other local model apps**: use them through a client above that speaks MCP (Open WebUI or LM Studio work with local models).

### Clients without OAuth (commerce only)

Make a personal access token in your Create store under **Settings → API access**, tick only what it needs, and send it as a header:

```json
{ "mcpServers": { "create-commerce": { "url": "https://mcp.create.com/commerce", "headers": { "Authorization": "Bearer crk_…" } } } }
```

Treat the token like a password; revoke it in the same place.

## What it will and won't do

- **Your permissions are the limit.** Each call uses your connection's permissions; a staff member's connection cannot do owner-only things.
- **It asks before big changes.** Every tool is annotated read-only, write, or destructive (deletes, publishes, production deploys, shopper emails, paid resources) so your assistant can confirm with you.
- **No money moves** through the commerce server's default tool set: refunds, cancellations, payouts, gift cards and shipping labels stay in your Create dashboard.
- **Secrets stay secret.** Secret values, API token values, card data and passwords are never returned.
- **Shopper text is data.** Order notes and messages are returned marked as untrusted data.
- **Disconnect any time**: Settings → Connected apps (store) · Account → Apps → Access (hosting).

## Links

- Docs: https://docs.create.com/docs/apps/mcp.md · https://docs.create.com/docs/commerce/mcp.md
- Privacy policy: https://www.create.com/policies/privacy-policy
- Terms of service: https://www.create.com/policies/terms-of-service
- Data processing addendum: https://www.create.com/policies/data-processing-addendum
- Support: support@create.com

<!-- Source of truth: integrations/mcp-listings/public-repo/ in Create's monorepo (published as github.com/createdotcom/create-mcp). -->
