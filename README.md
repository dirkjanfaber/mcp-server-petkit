# mcp-server-petkit

[![CI](https://github.com/dirkjanfaber/mcp-server-petkit/actions/workflows/ci.yml/badge.svg)](https://github.com/dirkjanfaber/mcp-server-petkit/actions/workflows/ci.yml)

MCP (Model Context Protocol) server for the [PetKit](https://www.petkit.com) cloud API. Exposes feeder status and control for the **Fresh Element Solo** (device type `D4`) as MCP tools.

> **Disclaimer:** This project is not affiliated with, endorsed by, or in any way associated with PetKit. It is an independent, community-developed integration created by a happy user of their hardware and software. PetKit and Fresh Element Solo are trademarks of their respective owner. Use of this package is at your own risk. The underlying API is unofficial and reverse-engineered by the community - it may change or break without notice.

## Tools

| Tool | Description |
|---|---|
| `list_feeders` | List all Fresh Element Solo feeders and their live state (food/battery/desiccant status, lock/light/sound settings, today's feed totals) |
| `feed_now` | Dispense food immediately |
| `update_feeder_setting` | Change a numeric setting (child lock, indicator light, dispense tone, shortage alarm, ...) |
| `skip_scheduled_feed` | Skip one of today's scheduled meals (`d4/removeDailyFeed`), leaving the recurring plan untouched |
| `restore_scheduled_feed` | Undo a skip for today (`d4/restoreDailyFeed`) |

### Feed amounts

The D4 only accepts these five portion sizes: `10`, `20`, `30`, `40`, `50`.

### Feed totals are per device, not per cat

`list_feeders` also returns `feedPlanToday`: today's scheduled meals from the feeder's weekly plan (`d4/device_detail`'s `multiFeedItem`), each with its readable `time`, the `feedTime` (seconds since midnight) that `skip_scheduled_feed` takes, the portion `amount` in `feed_now`'s units, and the meal `name`.

`list_feeders`' `fedToday`/`fedTodayScheduled`/`fedTodayExtra`/`fedTodayPlanned`/`dispensesToday`/`feedTimesToday` fields reflect what each *physical feeder* dispensed - PetKit has no way to attribute a dispense to a specific cat. If your cats share or steal from each other's bowls, these numbers won't tell you what any one cat actually ate.

### Common setting keys

| Key | Meaning |
|---|---|
| `manualLock` | Child lock (0/1) |
| `lightMode` | Indicator light |
| `feedSound` | Dispense tone (0/1) |
| `foodWarn` | Shortage alarm (0/1) |

Other numeric keys the device reports via `list_feeders` may also work but are unconfirmed.

## Configuration

Set the following environment variables before starting the server:

```bash
export PETKIT_EMAIL="your@email.com"
export PETKIT_PASSWORD="yourpassword"
export PETKIT_REGION="Netherlands"   # must match the exact region name shown in the PetKit app
export PETKIT_TIMEZONE="Europe/Amsterdam"   # optional, defaults to the host's own timezone
```

**Note:** PetKit account passwords are capped at 6-14 characters. A longer password
fails login with a generic "incorrect username or password" error indistinguishable
from an actually-wrong one - if login fails unexpectedly, check that first.

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "petkit": {
      "command": "npx",
      "args": ["mcp-server-petkit"],
      "env": {
        "PETKIT_EMAIL": "your@email.com",
        "PETKIT_PASSWORD": "yourpassword",
        "PETKIT_REGION": "Netherlands"
      }
    }
  }
}
```

## Remote use: claude.ai connector (HTTP + OAuth)

To use the server from claude.ai and the Claude mobile apps, run it in HTTP mode on an
always-on machine and add it as a custom connector. claude.ai connects from the
internet, so the server needs a public `https://` URL. A Cloudflare Tunnel or
Tailscale Funnel gives you one without opening ports on your router (see below).

HTTP mode is single-user: when you connect Claude, the server shows a page asking for
your **owner passphrase**. Anyone who knows it can authorize a client, and anyone with
a token can dispense food or change the feeding plan - pick a strong one.

```bash
npx mcp-server-petkit --http   # or MCP_TRANSPORT=http
```

| Variable | Default | |
|----------|---------|-|
| `MCP_PUBLIC_URL` | (required) | The `https://` URL claude.ai reaches the server on |
| `MCP_OWNER_PASSWORD` | (required) | Passphrase for authorizing Claude, at least 12 characters |
| `MCP_HOST` | `127.0.0.1` | Interface to listen on; the Docker image sets `0.0.0.0` |
| `MCP_PORT` | `3000` | |
| `MCP_STATE_FILE` | `~/.mcp-server-petkit/oauth-state.json` | Registered clients and refresh-token hashes, so Claude stays connected across restarts |

plus the `PETKIT_*` variables from [Configuration](#configuration).

### Docker (e.g. on a Raspberry Pi)

Each release publishes `ghcr.io/dirkjanfaber/mcp-server-petkit` for amd64, arm64 and
arm/v7 (32-bit Raspberry Pi OS), tagged with the version and `latest`. Put the PetKit and `MCP_*` settings in a `.env`
next to the compose file (`chmod 600 .env`), and give the server a public URL with one
of the two options below.

Private overlay networks such as ZeroTier or plain Tailscale aren't enough on their
own: claude.ai connects from Anthropic's servers, not from your devices.

#### Option 1: Cloudflare Tunnel (needs a domain on Cloudflare)

With a Cloudflare Tunnel alongside the server, no port needs publishing: in the
Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels**, create a Cloudflared
tunnel, and point its public hostname at `http://petkit-mcp:3000` (service type HTTP).
Put the tunnel's token in `.env` as `TUNNEL_TOKEN`:

```yaml
# docker-compose.yml
services:
  petkit-mcp:
    image: ghcr.io/dirkjanfaber/mcp-server-petkit:latest   # or pin a version, e.g. :0.3.0
    restart: unless-stopped
    env_file: .env   # PETKIT_*, MCP_PUBLIC_URL, MCP_OWNER_PASSWORD
    volumes:
      - petkit-data:/data
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    restart: unless-stopped
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
volumes:
  petkit-data:
```

Don't put Cloudflare Access in front of the hostname: claude.ai can't get past its
login page, and the owner passphrase already guards the server.

#### Option 2: Tailscale Funnel (no domain needed)

Tailscale Funnel gives the Pi a public `https://<machine>.<tailnet>.ts.net` URL. It runs
fine next to ZeroTier or other VPNs.

1. Install Tailscale on the Pi and log in:
   `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS Certificates**
   (under DNS) and allow Funnel for the machine. `tailscale funnel` offers a link
   to switch it on when it isn't allowed yet.
3. Publish the server's port on loopback only, so Funnel is the only way in:

   ```yaml
   # docker-compose.yml
   services:
     petkit-mcp:
       image: ghcr.io/dirkjanfaber/mcp-server-petkit:latest
       restart: unless-stopped
       env_file: .env   # PETKIT_*, MCP_PUBLIC_URL, MCP_OWNER_PASSWORD
       ports:
         - "127.0.0.1:3000:3000"
       volumes:
         - petkit-data:/data
   volumes:
     petkit-data:
   ```

4. Start the funnel. The setting persists across reboots:
   `sudo tailscale funnel --bg 3000`. `tailscale funnel status` shows the public URL.
   Put it in `.env` as `MCP_PUBLIC_URL`, then run `docker compose up -d`.

The URL contains the machine name, so rename the machine first if you want a nicer one.
Changing the URL later means updating `MCP_PUBLIC_URL` and reconnecting Claude.

#### Either way

Check the public URL before connecting Claude:

```bash
curl https://<your public host>/.well-known/oauth-authorization-server
```

It should return JSON whose `issuer` matches `MCP_PUBLIC_URL`. A freshly enabled
Funnel can take a minute to start answering.

Update with `docker compose pull && docker compose up -d`. To build the image yourself
instead, replace `image:` with `build: https://github.com/dirkjanfaber/mcp-server-petkit.git`.

The server trusts one proxy hop (`X-Forwarded-For` from the tunnel in front of it) for
rate limiting. Don't also publish its port directly to the internet.

### Connecting Claude

In claude.ai: **Settings → Connectors → Add custom connector**, with URL
`https://<your public host>/mcp`. Claude registers itself, opens the passphrase page,
and once you allow it, the tools show up in claude.ai and the mobile apps.

**PetKit allows one session per account.** The server's login signs the PetKit app
out (and vice versa); it re-logs in on its own when that happens, but expect the app
to ask you to log in again whenever the server restarts or its session lapses. Running
the stdio server, Node-RED's PetKit nodes, or a second HTTP instance on the same
account makes them take turns signing each other out.

## References

- Actively maintained reference client (Python) - https://github.com/Jezza34000/py-petkit-api - source of the confirmed-working client fingerprint and current endpoint constants
- Sibling Node-RED package with fuller protocol notes - [`node-red-contrib-petkit`](https://github.com/dirkjanfaber/node-red-contrib-petkit)'s `CLAUDE.md`
