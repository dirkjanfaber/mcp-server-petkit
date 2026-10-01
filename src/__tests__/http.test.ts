import { jest } from '@jest/globals';
import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { createHttpApp, HttpAppOptions } from '../http';
import { PetkitBackend } from '../types/petkit';

const PUBLIC_URL = new URL('https://petkit.example.com');
const OWNER_PASSWORD = 'correct horse battery staple';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

function makeApi(): PetkitBackend {
  return {
    authenticate: jest.fn(),
    getFeeders: jest.fn().mockResolvedValue([]),
    feedNow: jest.fn().mockResolvedValue(undefined),
    updateFeederSetting: jest.fn().mockResolvedValue(undefined),
    saveFeedPlan: jest.fn().mockResolvedValue(undefined),
    skipScheduledFeed: jest.fn().mockResolvedValue(undefined),
    restoreScheduledFeed: jest.fn().mockResolvedValue(undefined),
  } as unknown as PetkitBackend;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('HTTP transport with OAuth', () => {
  let stateDir: string;
  let clock: number;
  let api: PetkitBackend;

  function makeApp(overrides: Partial<HttpAppOptions> = {}) {
    return createHttpApp({
      api,
      version: '9.9.9',
      publicUrl: PUBLIC_URL,
      ownerPassword: OWNER_PASSWORD,
      stateFile: join(stateDir, 'state.json'),
      now: () => clock,
      ...overrides,
    });
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mcp-petkit-'));
    // Starts at the real time: the SDK's bearer middleware checks expiry against Date.now().
    clock = Date.now();
    api = makeApi();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function registerClient(app: ReturnType<typeof makeApp>): Promise<string> {
    const res = await request(app).post('/register').send({
      client_name: 'Claude',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(res.status).toBe(201);
    return res.body.client_id;
  }

  async function startAuthorization(app: ReturnType<typeof makeApp>, clientId: string, challenge: string) {
    const res = await request(app).get('/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    expect(res.status).toBe(200);
    const match = /name="request" value="([^"]+)"/.exec(res.text);
    expect(match).not.toBeNull();
    return { page: res.text, requestId: match![1] };
  }

  async function approve(app: ReturnType<typeof makeApp>, requestId: string, password: string) {
    return request(app).post('/approve').type('form').send({ request: requestId, password });
  }

  async function authorizeFully(app: ReturnType<typeof makeApp>) {
    const clientId = await registerClient(app);
    const { verifier, challenge } = pkce();
    const { requestId } = await startAuthorization(app, clientId, challenge);
    const approval = await approve(app, requestId, OWNER_PASSWORD);
    const code = new URL(approval.headers.location).searchParams.get('code')!;
    const tokenRes = await request(app).post('/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
    expect(tokenRes.status).toBe(200);
    return { clientId, tokens: tokenRes.body as { access_token: string; refresh_token: string; expires_in: number } };
  }

  function callMcp(app: ReturnType<typeof makeApp>, token: string | null, body: object) {
    const req = request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json');
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send(body);
  }

  const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  describe('discovery', () => {
    it('advertises the authorization server metadata at the public URL', async () => {
      const res = await request(makeApp()).get('/.well-known/oauth-authorization-server');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: 'https://petkit.example.com/',
        authorization_endpoint: 'https://petkit.example.com/authorize',
        token_endpoint: 'https://petkit.example.com/token',
        registration_endpoint: 'https://petkit.example.com/register',
        code_challenge_methods_supported: ['S256'],
      });
    });

    it('advertises /mcp as the protected resource', async () => {
      const res = await request(makeApp()).get('/.well-known/oauth-protected-resource/mcp');

      expect(res.status).toBe(200);
      expect(res.body.resource).toBe('https://petkit.example.com/mcp');
    });

    it('rejects an unauthenticated /mcp call with a pointer to the resource metadata', async () => {
      const res = await callMcp(makeApp(), null, TOOLS_LIST);

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain(
        'resource_metadata="https://petkit.example.com/.well-known/oauth-protected-resource/mcp"',
      );
    });
  });

  describe('authorization', () => {
    it('shows a passphrase form that names the client asking for access', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);

      const { page } = await startAuthorization(app, clientId, pkce().challenge);

      expect(page).toContain('Claude');
      expect(page).toContain('type="password"');
    });

    it('redirects back with a code and the original state once the passphrase is right', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { requestId } = await startAuthorization(app, clientId, pkce().challenge);

      const res = await approve(app, requestId, OWNER_PASSWORD);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
      expect(location.searchParams.get('code')).toBeTruthy();
      expect(location.searchParams.get('state')).toBe('xyz');
    });

    it('re-shows the form without redirecting when the passphrase is wrong', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { requestId } = await startAuthorization(app, clientId, pkce().challenge);

      const res = await approve(app, requestId, 'wrong');

      expect(res.status).toBe(401);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).toContain('type="password"');
    });

    it('drops the request after five wrong passphrases, even if the sixth is right', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { requestId } = await startAuthorization(app, clientId, pkce().challenge);

      for (let i = 0; i < 5; i++) {
        await approve(app, requestId, 'wrong');
      }
      const res = await approve(app, requestId, OWNER_PASSWORD);

      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('expires an authorization request that is left open too long', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { requestId } = await startAuthorization(app, clientId, pkce().challenge);

      clock += 11 * 60 * 1000;
      const res = await approve(app, requestId, OWNER_PASSWORD);

      expect(res.status).toBe(400);
    });

    it('rejects an approval post with no fields', async () => {
      const res = await request(makeApp()).post('/approve').type('form').send({});

      expect(res.status).toBe(400);
    });

    it('rejects an unknown authorization request', async () => {
      const res = await approve(makeApp(), 'nope', OWNER_PASSWORD);

      expect(res.status).toBe(400);
    });
  });

  describe('tokens', () => {
    it('lets an authorized client call the tools', async () => {
      const app = makeApp();
      const { tokens } = await authorizeFully(app);

      const res = await callMcp(app, tokens.access_token, TOOLS_LIST);

      expect(res.status).toBe(200);
      expect(res.body.result.tools.map((t: { name: string }) => t.name)).toContain('list_feeders');
    });

    it('runs tool calls against the configured PetKit backend', async () => {
      const app = makeApp();
      const { tokens } = await authorizeFully(app);

      const res = await callMcp(app, tokens.access_token, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_feeders', arguments: {} },
      });

      expect(res.status).toBe(200);
      expect(api.getFeeders).toHaveBeenCalled();
      expect(JSON.parse(res.body.result.content[0].text)).toEqual([]);
    });

    it('rejects a wrong PKCE verifier', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { challenge } = pkce();
      const { requestId } = await startAuthorization(app, clientId, challenge);
      const approval = await approve(app, requestId, OWNER_PASSWORD);
      const code = new URL(approval.headers.location).searchParams.get('code')!;

      const res = await request(app).post('/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pkce().verifier,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('accepts an authorization code only once', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorization(app, clientId, challenge);
      const approval = await approve(app, requestId, OWNER_PASSWORD);
      const code = new URL(approval.headers.location).searchParams.get('code')!;
      const exchange = () => request(app).post('/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
      });

      expect((await exchange()).status).toBe(200);
      const second = await exchange();
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('invalid_grant');
    });

    it('rejects an authorization code issued to a different client', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const otherClientId = await registerClient(app);
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorization(app, clientId, challenge);
      const approval = await approve(app, requestId, OWNER_PASSWORD);
      const code = new URL(approval.headers.location).searchParams.get('code')!;

      const res = await request(app).post('/token').type('form').send({
        grant_type: 'authorization_code', client_id: otherClientId, code, code_verifier: verifier,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a token exchange with a different redirect_uri than was authorized', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorization(app, clientId, challenge);
      const approval = await approve(app, requestId, OWNER_PASSWORD);
      const code = new URL(approval.headers.location).searchParams.get('code')!;

      const res = await request(app).post('/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
        redirect_uri: 'https://evil.example.com/callback',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects an expired authorization code', async () => {
      const app = makeApp();
      const clientId = await registerClient(app);
      const { verifier, challenge } = pkce();
      const { requestId } = await startAuthorization(app, clientId, challenge);
      const approval = await approve(app, requestId, OWNER_PASSWORD);
      const code = new URL(approval.headers.location).searchParams.get('code')!;

      clock += 6 * 60 * 1000;
      const res = await request(app).post('/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects an access token once it has expired', async () => {
      const app = makeApp();
      const { tokens } = await authorizeFully(app);

      clock += tokens.expires_in * 1000 + 1;
      const res = await callMcp(app, tokens.access_token, TOOLS_LIST);

      expect(res.status).toBe(401);
    });

    it('rejects a made-up access token', async () => {
      const res = await callMcp(makeApp(), 'not-a-token', TOOLS_LIST);

      expect(res.status).toBe(401);
    });

    it('rotates the refresh token: the new pair works, the old refresh token does not', async () => {
      const app = makeApp();
      const { clientId, tokens } = await authorizeFully(app);
      const refresh = (token: string) => request(app).post('/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: token,
      });

      const first = await refresh(tokens.refresh_token);
      expect(first.status).toBe(200);
      expect((await callMcp(app, first.body.access_token, TOOLS_LIST)).status).toBe(200);

      const replay = await refresh(tokens.refresh_token);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('invalid_grant');
    });

    it('rejects a refresh token presented by a different client', async () => {
      const app = makeApp();
      const { tokens } = await authorizeFully(app);
      const otherClientId = await registerClient(app);

      const res = await request(app).post('/token').type('form').send({
        grant_type: 'refresh_token', client_id: otherClientId, refresh_token: tokens.refresh_token,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects an expired refresh token', async () => {
      const app = makeApp();
      const { clientId, tokens } = await authorizeFully(app);

      clock += 91 * 24 * 60 * 60 * 1000;
      const res = await request(app).post('/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('revokes a refresh token', async () => {
      const app = makeApp();
      const { clientId, tokens } = await authorizeFully(app);

      const revoke = await request(app).post('/revoke').type('form').send({
        client_id: clientId, token: tokens.refresh_token,
      });
      expect(revoke.status).toBe(200);

      const res = await request(app).post('/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token,
      });
      expect(res.status).toBe(400);
    });

    it('revokes an access token', async () => {
      const app = makeApp();
      const { clientId, tokens } = await authorizeFully(app);

      await request(app).post('/revoke').type('form').send({ client_id: clientId, token: tokens.access_token });

      expect((await callMcp(app, tokens.access_token, TOOLS_LIST)).status).toBe(401);
    });
  });

  describe('persistence', () => {
    it('keeps registered clients and refresh tokens across a restart, but not access tokens', async () => {
      const { clientId, tokens } = await authorizeFully(makeApp());

      const restarted = makeApp();
      expect((await callMcp(restarted, tokens.access_token, TOOLS_LIST)).status).toBe(401);

      const res = await request(restarted).post('/token').type('form').send({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token,
      });
      expect(res.status).toBe(200);
      expect((await callMcp(restarted, res.body.access_token, TOOLS_LIST)).status).toBe(200);
    });

    it('stores only hashes of refresh tokens on disk', async () => {
      const { tokens } = await authorizeFully(makeApp());

      const onDisk = readFileSync(join(stateDir, 'state.json'), 'utf8');

      expect(onDisk).not.toContain(tokens.refresh_token);
      expect(onDisk).toContain(createHash('sha256').update(tokens.refresh_token).digest('hex'));
    });

    it('refuses to start when the state file exists but cannot be read', () => {
      // A directory where the file should be: fail loudly instead of silently
      // starting with empty state and dropping every registered client.
      expect(() => makeApp({ stateFile: stateDir })).toThrow(/EISDIR/);
    });

    it('creates the state file directory when it does not exist yet', async () => {
      const stateFile = join(stateDir, 'nested', 'dir', 'state.json');

      await registerClient(makeApp({ stateFile }));

      expect(JSON.parse(readFileSync(stateFile, 'utf8')).clients).toBeDefined();
    });
  });

  describe('transport', () => {
    it('answers GET /mcp with 405, since the server is stateless and has no stream to resume', async () => {
      const app = makeApp();
      const { tokens } = await authorizeFully(app);

      const res = await request(app).get('/mcp').set('Authorization', `Bearer ${tokens.access_token}`);

      expect(res.status).toBe(405);
    });
  });
});
