import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Response } from 'express';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const PENDING_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PASSPHRASE_ATTEMPTS = 5;

interface PendingRequest {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
  attemptsLeft: number;
}

interface AuthorizationCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

interface IssuedToken {
  clientId: string;
  expiresAt: number;
}

// What survives a restart. Refresh tokens are stored by SHA-256 hash, so the file alone
// can't be used to mint access tokens. Access tokens live in memory only - after a
// restart the client refreshes, which is invisible to the user.
interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, IssuedToken>;
}

export type ApprovalResult =
  | { kind: 'approved'; redirectUrl: string }
  | { kind: 'wrong-passphrase'; client: OAuthClientInformationFull; requestId: string }
  | { kind: 'unknown-request' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function passphraseMatches(given: string, expected: string): boolean {
  // Compare fixed-length digests so neither the length nor the content leaks via timing.
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function renderApprovalPage(client: OAuthClientInformationFull, requestId: string, error?: string): string {
  const clientName = escapeHtml(client.client_name ?? client.client_id);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize PetKit access</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; }
  input, button { font: inherit; padding: .5rem; width: 100%; box-sizing: border-box; margin-top: .5rem; }
  .error { color: #b00020; }
</style>
</head>
<body>
<h1>Authorize PetKit access</h1>
<p><strong>${clientName}</strong> wants to control your PetKit feeders.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="approve">
  <input type="hidden" name="request" value="${escapeHtml(requestId)}">
  <label>Passphrase <input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <button type="submit">Allow</button>
</form>
</body>
</html>`;
}

// A single-user OAuth server: whoever knows the owner passphrase can authorize a client.
// Clients register themselves (dynamic client registration), as claude.ai does.
export class OwnerOAuthProvider implements OAuthServerProvider {
  private state: PersistedState = { clients: {}, refreshTokens: {} };
  private pending = new Map<string, PendingRequest>();
  private codes = new Map<string, AuthorizationCode>();
  private accessTokens = new Map<string, IssuedToken>();

  constructor(
    private readonly ownerPassword: string,
    private readonly stateFile: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: client => {
        const full = client as OAuthClientInformationFull;
        this.state.clients[full.client_id] = full;
        this.save();
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = newToken();
    this.pending.set(requestId, {
      clientId: client.client_id,
      params,
      expiresAt: this.now() + PENDING_REQUEST_TTL_MS,
      attemptsLeft: MAX_PASSPHRASE_ATTEMPTS,
    });
    res.status(200).type('html').send(renderApprovalPage(client, requestId));
  }

  // Called by the /approve form handler, which is ours rather than the SDK's.
  approve(requestId: string, passphrase: string): ApprovalResult {
    const request = this.pending.get(requestId);
    const client = request && this.state.clients[request.clientId];
    if (!request || !client || request.expiresAt < this.now()) {
      this.pending.delete(requestId);
      return { kind: 'unknown-request' };
    }

    if (!passphraseMatches(passphrase, this.ownerPassword)) {
      request.attemptsLeft--;
      if (request.attemptsLeft <= 0) {
        this.pending.delete(requestId);
      }
      return { kind: 'wrong-passphrase', client, requestId };
    }

    this.pending.delete(requestId);
    const code = newToken();
    this.codes.set(code, {
      clientId: request.clientId,
      codeChallenge: request.params.codeChallenge,
      redirectUri: request.params.redirectUri,
      expiresAt: this.now() + AUTHORIZATION_CODE_TTL_MS,
    });

    const redirect = new URL(request.params.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.params.state !== undefined) {
      redirect.searchParams.set('state', request.params.state);
    }
    return { kind: 'approved', redirectUrl: redirect.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.validCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.validCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the one used to authorize');
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const stored = this.state.refreshTokens[hash];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < this.now()) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    // Rotate: a refresh token works once.
    delete this.state.refreshTokens[hash];
    return this.issueTokens(client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.accessTokens.get(token);
    if (!stored || stored.expiresAt < this.now()) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return { token, clientId: stored.clientId, scopes: [], expiresAt: Math.floor(stored.expiresAt / 1000) };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.accessTokens.delete(request.token);
    const hash = sha256(request.token);
    if (this.state.refreshTokens[hash]) {
      delete this.state.refreshTokens[hash];
      this.save();
    }
  }

  private validCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCode {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt < this.now()) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    return code;
  }

  private issueTokens(clientId: string): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    this.accessTokens.set(accessToken, { clientId, expiresAt: this.now() + ACCESS_TOKEN_TTL_MS });
    this.state.refreshTokens[sha256(refreshToken)] = { clientId, expiresAt: this.now() + REFRESH_TOKEN_TTL_MS };
    this.save();
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
    };
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.stateFile, 'utf8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
    this.state = JSON.parse(raw);
  }

  private save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated state file.
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }
}
