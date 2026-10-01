import { join } from 'path';
import { loadHttpConfig } from '../config';

const BASE_ENV = {
  MCP_PUBLIC_URL: 'https://petkit.example.com',
  MCP_OWNER_PASSWORD: 'a long enough passphrase',
};

describe('loadHttpConfig()', () => {
  it('applies defaults for host, port and state file', () => {
    expect(loadHttpConfig(BASE_ENV, '/home/pi')).toEqual({
      publicUrl: new URL('https://petkit.example.com'),
      ownerPassword: 'a long enough passphrase',
      host: '127.0.0.1',
      port: 3000,
      stateFile: join('/home/pi', '.mcp-server-petkit', 'oauth-state.json'),
    });
  });

  it('takes host, port and state file from the environment', () => {
    const config = loadHttpConfig({
      ...BASE_ENV, MCP_HOST: '0.0.0.0', MCP_PORT: '8080', MCP_STATE_FILE: '/data/oauth-state.json',
    }, '/home/pi');

    expect(config).toMatchObject({ host: '0.0.0.0', port: 8080, stateFile: '/data/oauth-state.json' });
  });

  it('requires a public URL', () => {
    expect(() => loadHttpConfig({ MCP_OWNER_PASSWORD: BASE_ENV.MCP_OWNER_PASSWORD }, '/home/pi'))
      .toThrow(/MCP_PUBLIC_URL/);
  });

  it('requires the public URL to be https, since claude.ai only connects over HTTPS', () => {
    expect(() => loadHttpConfig({ ...BASE_ENV, MCP_PUBLIC_URL: 'http://petkit.example.com' }, '/home/pi'))
      .toThrow(/https/);
  });

  it('rejects a public URL that does not parse', () => {
    expect(() => loadHttpConfig({ ...BASE_ENV, MCP_PUBLIC_URL: 'not a url' }, '/home/pi'))
      .toThrow(/MCP_PUBLIC_URL/);
  });

  it('requires an owner passphrase of at least 12 characters', () => {
    expect(() => loadHttpConfig({ MCP_PUBLIC_URL: BASE_ENV.MCP_PUBLIC_URL }, '/home/pi'))
      .toThrow(/MCP_OWNER_PASSWORD/);
    expect(() => loadHttpConfig({ ...BASE_ENV, MCP_OWNER_PASSWORD: 'short' }, '/home/pi'))
      .toThrow(/at least 12/);
  });

  it('rejects a port that is not a valid number', () => {
    expect(() => loadHttpConfig({ ...BASE_ENV, MCP_PORT: 'eighty' }, '/home/pi')).toThrow(/MCP_PORT/);
    expect(() => loadHttpConfig({ ...BASE_ENV, MCP_PORT: '70000' }, '/home/pi')).toThrow(/MCP_PORT/);
  });
});
