export * from './backend.js';
export * from './errors.js';
export * from './tar.js';
export * from './secret-files.js';
export * from './tools.js';
export * from './server.js';
export * from './http.js';
export * from './stdio.js';
export * from './http-backend.js';
export * from './edge.js';
export * from './catalogue.js';

/** The hosting MCP server's identity, as `initialize` / `server/discover` report it (`websiteUrl`: MCP 2025-11-25 `Implementation`, shown by directories and clients). */
export const APPS_MCP_SERVER_INFO = { name: 'create-apps', title: 'Create app hosting', version: '0.1.0', websiteUrl: 'https://www.create.com' } as const;

/** P2: the anonymous-deploy limits, for clients (the CLI) that check before uploading. */
export { APPS_ANON_LIMITS } from '@create/shared';
export * from './directory-pack.js';
