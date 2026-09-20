# mcp-server-petkit

[![CI](https://github.com/dirkjanfaber/mcp-server-petkit/actions/workflows/ci.yml/badge.svg)](https://github.com/dirkjanfaber/mcp-server-petkit/actions/workflows/ci.yml)

MCP (Model Context Protocol) server for the [PetKit](https://www.petkit.com) cloud API. Exposes feeder status and control for the **Fresh Element Solo** (device type `D4`) as MCP tools.

> **Disclaimer:** This project is not affiliated with, endorsed by, or in any way associated with PetKit. It is an independent, community-developed integration created by a happy user of their hardware and software. PetKit and Fresh Element Solo are trademarks of their respective owner. Use of this package is at your own risk. The underlying API is unofficial and reverse-engineered by the community - it may change or break without notice.

## Tools

| Tool | Description |
|---|---|
| `list_feeders` | List all Fresh Element Solo feeders and their live state (food/battery/desiccant status, lock/light/sound settings) |
| `feed_now` | Dispense food immediately |
| `update_feeder_setting` | Change a numeric setting (child lock, indicator light, dispense tone, shortage alarm, ...) |

### Feed amounts

The D4 only accepts these five portion sizes: `10`, `20`, `30`, `40`, `50`.

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

## References

- Actively maintained reference client (Python) - https://github.com/Jezza34000/py-petkit-api - source of the confirmed-working client fingerprint and current endpoint constants
- Sibling Node-RED package with fuller protocol notes - [`node-red-contrib-petkit`](https://github.com/dirkjanfaber/node-red-contrib-petkit)'s `CLAUDE.md`
