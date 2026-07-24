<div align="center">
  <img src="frontend/public/icon.svg" alt="SkyGenPanel logo" width="104" height="104">

  <h1>SkyGenPanel</h1>

  <p><strong>A focused operations console and customer self-service portal for GenieACS.</strong></p>
  <p>Monitor ONTs, manage network topology, configure multi-vendor devices, and give customers a safe view of their own connection from one lightweight service.</p>

  <p>
    <a href="https://github.com/skydashnet/genieacs-panel/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/skydashnet/genieacs-panel?sort=semver&style=for-the-badge&label=Release&color=173F35"></a>
    <img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
    <img alt="React and Vite" src="https://img.shields.io/badge/React%20%2B%20Vite-Production-646CFF?style=for-the-badge&logo=vite&logoColor=white">
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-D97706?style=for-the-badge"></a>
  </p>

  <p>
    <a href="#installation">Installation</a> ·
    <a href="#skygenpanel-cli">CLI</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#security">Security</a>
  </p>
</div>

---

## Overview

SkyGenPanel is a management layer for GenieACS deployments. It combines an operator-facing panel on port `5890` with an isolated customer portal on port `5891`. SQLite works out of the box, while MySQL can be selected and migrated to later from the interface.

| Operator console | Customer portal |
| --- | --- |
| Fleet health, faults, optical signal, temperature, and registration trends | ONT health, optical signal, uptime, and connected-device visibility |
| ONT, OLT, ODC, and ODP topology management with a network map | Permanent Customer IDs bound to SoftwareVersion and PPPoE identity |
| Multi-vendor WAN, WiFi, credential, and virtual-parameter configuration | Safe SSID and WiFi password changes for the authenticated customer's ONT |
| Runtime SQLite-to-MySQL migration and deployment controls | No WAN or administrative credential exposure |

## Highlights

- Dedicated operator and customer listeners served by one application.
- First-run setup wizard for the initial administrator account.
- Fast Vite and React interface with responsive light and dark themes.
- GenieACS fault visibility and dependency-light dashboard charts.
- Network topology editor with Google Maps and OpenStreetMap-compatible providers.
- Automatic Customer ID generation that can be enabled or disabled in Settings.
- Encrypted recovery of the last WiFi password changed through the customer portal.
- Automatic Linux dependency and Node.js installation through the production installer.

## Installation

The production installer targets Linux systems running `systemd`. It supports:

- Debian and Ubuntu
- Fedora, RHEL, Rocky Linux, and AlmaLinux
- Arch Linux
- openSUSE

Git, native build tools, and Node.js 22 are installed automatically when required. An existing Node.js 20 or newer installation is reused.

Run as a regular user:

```bash
curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | sudo bash
```

Run from an existing root shell:

```bash
curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | bash
```

After installation:

- Operator setup: `http://localhost:5890`
- Customer portal: `http://localhost:5891`

Both listeners bind to `127.0.0.1` by default. This is suitable for a reverse proxy or a Cloudflare Tunnel running on the same host. Use `skygenpanel expose` only when another trusted machine must reach the service directly, and protect the ports with a firewall.

## `skygenpanel` CLI

| Command | Description |
| --- | --- |
| `skygenpanel update` | Fetch the latest source, rebuild the application, and restart the service |
| `skygenpanel expose` | Bind the panel and customer portal to `0.0.0.0` |
| `skygenpanel unexpose` | Return both listeners to `127.0.0.1` |
| `skygenpanel restart` | Restart the system service |
| `skygenpanel start` | Start the system service |
| `skygenpanel stop` | Stop the system service |
| `skygenpanel status` | Show service and endpoint status |
| `skygenpanel logs [N]` | Follow the latest log lines; defaults to 100 |
| `skygenpanel reset-password <user> [password]` | Reset an operator password; prompts securely when the password is omitted |

## Cloudflare Tunnel

When `cloudflared` runs on the SkyGenPanel host, publish two HTTP services:

| Public hostname | Origin service |
| --- | --- |
| `panel.example.com` | `http://127.0.0.1:5890` |
| `portal.example.com` | `http://127.0.0.1:5891` |

TLS terminates at Cloudflare, so the local origin URLs intentionally use HTTP. Keep Universal SSL active for the zone and wait for its edge certificate to reach `Active` before forcing HTTPS redirects.

## Configuration

Environment configuration lives in `backend/.env`; see [`backend/.env.example`](backend/.env.example).

| Variable | Purpose |
| --- | --- |
| `APP_HOST` | Operator panel bind address |
| `APP_PORT` | Operator panel port; defaults to `5890` |
| `PORTAL_HOST` | Optional customer portal bind address |
| `PORTAL_PORT` | Customer portal port; defaults to `5891` |
| `JWT_SECRET` | Stable application secret used for sessions and encrypted WiFi credential recovery |
| `PORTAL_JWT_SECRET` | Optional independent customer-session secret |
| `CORS_ORIGINS` | Explicitly allowed browser origins |
| `DATA_DIR` | Optional persistent application data directory |
| `TRUST_PROXY` | Set to `1` only when requests arrive through a trusted direct proxy |

The GenieACS URL and optional MySQL connection are managed from the Settings interface rather than environment variables. Runtime database configuration is stored in `DATA_DIR/db-config.json`.

## Database Migration

Open **Settings → Database** as an administrator to:

1. Inspect the active database configuration.
2. Test a MySQL connection.
3. Migrate existing application data.
4. Switch the running application to the new database.

The migration includes related customer accounts and encrypted customer WiFi credentials.

## Development

```bash
git clone https://github.com/skydashnet/genieacs-panel.git
cd genieacs-panel
npm run install:all
npm run dev:backend
npm run dev:frontend
```

Useful project checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Build and run the production bundle locally:

```bash
npm run build
npm start
```

## Architecture

- **Backend:** Node.js, Express 5, Knex, SQLite, MySQL, and JWT.
- **Frontend:** Vite, React, React Router, TypeScript, and Tailwind CSS.
- **Deployment:** `systemd`, hardened service boundaries, automatic dependency installation, and an update-safe CLI.
- **Integration:** GenieACS NBI with typed task values and multi-vendor parameter discovery.

The operator and customer APIs use separate listeners. Administrative routes are not mounted on the customer portal port.

## Security

- Role-based operator access with bcrypt password hashing and separate access and refresh tokens.
- Customer sessions stored in `HttpOnly`, `SameSite=Strict` cookies.
- Customer actions resolve the target device exclusively from the authenticated account.
- Saved WiFi passwords protected at rest with authenticated AES-256-GCM encryption.
- Password values revealed only through an authenticated, rate-limited request.
- Same-origin mutation checks, strict CSP, security headers, and request-size limits.
- Dedicated rate limits for login, portal API access, WiFi mutations, and password reveals.
- Session revocation after operator password changes and logout.
- Loopback-only listeners by default.
- Hardened `systemd` unit with restricted write paths and `NoNewPrivileges`.

Keep `JWT_SECRET` stable across reinstallations and container replacements. Changing it invalidates existing sessions and makes previously encrypted WiFi credentials unreadable.

## Docker

```bash
docker build -t skygenpanel .
docker run \
  -p 5890:5890 \
  -p 5891:5891 \
  -v skygenpanel-data:/var/lib/skygenpanel \
  -e DATA_DIR=/var/lib/skygenpanel \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  skygenpanel
```

## License

SkyGenPanel is available under the [MIT License](LICENSE).

For support, email [support@skydash.net](mailto:support@skydash.net) or open a [GitHub issue](https://github.com/skydashnet/genieacs-panel/issues).

<div align="center">
  <sub>© 2024–2026 SkydashNET</sub>
</div>
