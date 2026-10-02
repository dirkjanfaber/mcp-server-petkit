#!/usr/bin/env node
import { homedir } from 'os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadHttpConfig } from './config.js';
import { createHttpApp } from './http.js';
import { PetkitCloudAPI } from './lib/petkit-api.js';
import { createServer } from './server.js';

const VERSION = '0.3.1';

const email = process.env.PETKIT_EMAIL ?? '';
const password = process.env.PETKIT_PASSWORD ?? '';
const region = process.env.PETKIT_REGION ?? '';
const timezone = process.env.PETKIT_TIMEZONE;

if (!email || !password || !region) {
  console.error('PETKIT_EMAIL, PETKIT_PASSWORD, and PETKIT_REGION environment variables are required');
  console.error('PETKIT_REGION must match the exact region name shown in the PetKit app (e.g. "Netherlands", "United States")');
  process.exit(1);
}

const api = new PetkitCloudAPI({ email, password, region, timezone });
const httpMode = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

async function main() {
  if (httpMode) {
    const config = loadHttpConfig(process.env, homedir());
    const app = createHttpApp({
      api,
      version: VERSION,
      publicUrl: config.publicUrl,
      ownerPassword: config.ownerPassword,
      stateFile: config.stateFile,
    });
    app.listen(config.port, config.host, () => {
      console.error(`mcp-server-petkit ${VERSION} listening on http://${config.host}:${config.port}/mcp (public: ${new URL('/mcp', config.publicUrl)})`);
    });
    return;
  }

  const server = createServer(api, VERSION);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
