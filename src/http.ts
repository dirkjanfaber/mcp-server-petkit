import express from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OwnerOAuthProvider, renderApprovalPage } from './oauth.js';
import { createServer } from './server.js';
import { PetkitBackend } from './types/petkit.js';

export interface HttpAppOptions {
  api: PetkitBackend;
  version: string;
  // The HTTPS URL claude.ai reaches this server on (e.g. a Cloudflare Tunnel hostname) -
  // used as the OAuth issuer and to build /mcp's resource URL.
  publicUrl: URL;
  // Passphrase asked for on the authorize page before a client gets a token.
  ownerPassword: string;
  // Where registered clients and refresh-token hashes are kept across restarts.
  stateFile: string;
  now?: () => number;
}

export function createHttpApp(options: HttpAppOptions): express.Express {
  const provider = new OwnerOAuthProvider(options.ownerPassword, options.stateFile, options.now);
  const mcpUrl = new URL('/mcp', options.publicUrl);

  const app = express();
  // Meant to run behind one reverse proxy (cloudflared, a tunnel sidecar), so the auth
  // router's rate limiting sees the real client address rather than the proxy's.
  app.set('trust proxy', 1);

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: options.publicUrl,
    resourceServerUrl: mcpUrl,
    resourceName: 'PetKit feeders',
  }));

  app.post('/approve', express.urlencoded({ extended: false }), (req, res) => {
    const result = provider.approve(String(req.body?.request ?? ''), String(req.body?.password ?? ''));
    switch (result.kind) {
      case 'approved':
        res.redirect(302, result.redirectUrl);
        return;
      case 'wrong-passphrase':
        res.status(401).type('html').send(renderApprovalPage(result.client, result.requestId, 'Wrong passphrase.'));
        return;
      case 'unknown-request':
        res.status(400).type('text').send('This authorization request has expired or is unknown. Start again from Claude.');
        return;
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless: a fresh server + transport per request, sharing one PetKit client (and so
  // one PetKit session) across all of them.
  app.post('/mcp', bearer, express.json(), async (req, res) => {
    const server = createServer(options.api, options.version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' },
      id: null,
    });
  });

  return app;
}
