#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PetkitCloudAPI } from './lib/petkit-api.js';
import { createServer } from './server.js';

const VERSION = '0.2.0';

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
const server = createServer(api, VERSION);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
