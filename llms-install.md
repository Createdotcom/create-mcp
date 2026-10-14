# Installing the Create.com MCP servers (for AI agents such as Cline)

Create runs two **remote** MCP servers. There is nothing to download, build or run locally: add the URL and the client signs in with OAuth on first use.

| Key | URL | Use it for |
|---|---|---|
| `create` | `https://mcp.create.com/apps` | Deploying and running apps on Create app hosting |
| `create-commerce` | `https://mcp.create.com/commerce` | Working in one Create online store |

## Steps

1. Ask the user which one they want (or both).
2. Add it to the MCP settings file as a streamable HTTP server. For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "create": { "type": "streamableHttp", "url": "https://mcp.create.com/apps" },
    "create-commerce": { "type": "streamableHttp", "url": "https://mcp.create.com/commerce" }
  }
}
```

3. On the first tool call the server answers `401` with an OAuth challenge. The client opens Create's sign-in in the browser; the user signs in, chooses permissions (and, for commerce, one store) and approves. No API key is needed.
4. If the client cannot do OAuth, the user can make a personal access token instead: in their Create store, **Settings → API access → Create token** (commerce only), then add a header: `"headers": { "Authorization": "Bearer crk_…" }`. Never print or log the token.
5. Verify: call `get_usage` (hosting) or `get_stores_by_storeId_launch_checklist` / any `get_…` tool (commerce).

## Notes

- Commerce tool sets: append `?profile=commerce` for catalog + checkout links only. The default is everything except tools that move money.
- Destructive tools (deletes, publishes, production deploys, shopper emails, paid resources) are marked with `destructiveHint`; ask the user before each.
- Docs: https://docs.create.com/docs/apps/mcp.md and https://docs.create.com/docs/commerce/mcp.md
