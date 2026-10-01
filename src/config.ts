import { join } from 'path';

const MIN_OWNER_PASSWORD_LENGTH = 12;

export interface HttpConfig {
  publicUrl: URL;
  ownerPassword: string;
  host: string;
  port: number;
  stateFile: string;
}

export function loadHttpConfig(env: Record<string, string | undefined>, homeDir: string): HttpConfig {
  if (!env.MCP_PUBLIC_URL) {
    throw new Error('MCP_PUBLIC_URL is required in HTTP mode: the https:// URL claude.ai reaches this server on');
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(env.MCP_PUBLIC_URL);
  } catch {
    throw new Error(`MCP_PUBLIC_URL is not a valid URL: ${env.MCP_PUBLIC_URL}`);
  }
  if (publicUrl.protocol !== 'https:') {
    throw new Error('MCP_PUBLIC_URL must be https:// - claude.ai only connects to HTTPS servers');
  }

  const ownerPassword = env.MCP_OWNER_PASSWORD ?? '';
  if (!ownerPassword) {
    throw new Error('MCP_OWNER_PASSWORD is required in HTTP mode: the passphrase asked for when connecting Claude');
  }
  if (ownerPassword.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new Error(`MCP_OWNER_PASSWORD must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters`);
  }

  const port = Number(env.MCP_PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MCP_PORT must be a port number, got: ${env.MCP_PORT}`);
  }

  return {
    publicUrl,
    ownerPassword,
    // Loopback by default: a tunnel on the same machine reaches it, nothing else does.
    // A container sets 0.0.0.0 so its published port works.
    host: env.MCP_HOST ?? '127.0.0.1',
    port,
    stateFile: env.MCP_STATE_FILE ?? join(homeDir, '.mcp-server-petkit', 'oauth-state.json'),
  };
}
