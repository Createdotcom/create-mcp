# @create.com/cli

Deploy apps to [Create](https://www.create.com) from your terminal, or give your AI agent Create's
hosting tools through a local MCP server.

Requires Node.js 20 or newer (22.18 or newer to build framework sites on your machine).

## Sign in

```sh
npx @create.com/cli login
```

This opens a browser to approve the sign-in (OAuth device flow). The session is stored in
`~/.config/create/credentials.json` (on Windows, `%APPDATA%\create`).

## Deploy from a terminal

```sh
npx @create.com/cli deploy            # in your app's folder
npx @create.com/cli deploy --json     # machine-readable output for scripts and agents
npx @create.com/cli --help            # every command
```

Install it globally to get a `create` command:

```sh
npm i -g @create.com/cli
create deploy
```

## Use it as an MCP server for AI agents

```sh
npx -y @create.com/cli mcp
```

`create mcp` serves Create's hosting tools over stdio. Sign in first (`npx @create.com/cli login`):
the server stops with "You are not signed in to Create" otherwise. The agent may only deploy folders
inside the directory the server was started in.

Building framework sites (Next.js, Astro, SvelteKit, …) on your machine runs the folder's `npm install`
and build scripts as you, so it is off unless you add `--local-builds` to the server's arguments.

### Claude Code

```sh
claude mcp add create -- npx -y @create.com/cli mcp
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.create]
command = "npx"
args = ["-y", "@create.com/cli", "mcp"]
```

### Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "create": {
      "command": "npx",
      "args": ["-y", "@create.com/cli", "mcp"]
    }
  }
}
```

## Environment

| Variable | Purpose |
| --- | --- |
| `CREATE_API_URL` | The Create API to talk to (default `https://api.create.com`). For staging: `https://api.staging.create.com` — sign in again against it (`CREATE_API_URL=https://api.staging.create.com npx @create.com/cli login`) and pass the same variable in the MCP server's `env`. |
| `CREATE_CONFIG_DIR` | Where the sign-in and settings are stored. |
| `CREATE_NO_BROWSER` | Set to `1` to print the sign-in link without opening a browser. |

## License

Apache-2.0. The bundle includes third-party code under its own licenses; see
`dist/THIRD_PARTY_LICENSES.txt`.
