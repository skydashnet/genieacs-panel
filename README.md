<div align="center">
  <img src="frontend/public/icon.svg" alt="TR69 Controle logo" width="104" height="104">

  <h1>TR69 Controle</h1>

  <p><strong>A focused operations console and customer self-service portal for GenieACS.</strong></p>
  <p>Monitor ONTs, manage network topology, configure multi-vendor devices, and give customers a safe view of their own connection from one lightweight service.</p>

  <p>
    <a href="https://github.com/skydashnet/genieacs-panel/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/skydashnet/genieacs-panel?sort=semver&style=for-the-badge&label=Release&color=173F35"></a>
    <a href="https://github.com/skydashnet/genieacs-panel/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/skydashnet/genieacs-panel?style=for-the-badge&logo=github&color=D97706"></a>
    <a href="https://github.com/skydashnet/genieacs-panel/forks"><img alt="GitHub forks" src="https://img.shields.io/github/forks/skydashnet/genieacs-panel?style=for-the-badge&logo=github&color=2563EB"></a>
    <img alt="Node.js 22.22 or newer" src="https://img.shields.io/badge/Node.js-22.22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
    <img alt="React and Vite" src="https://img.shields.io/badge/React%20%2B%20Vite-Production-646CFF?style=for-the-badge&logo=vite&logoColor=white">
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-D97706?style=for-the-badge"></a>
    <a href="https://saweria.co/skydashnet"><img alt="Support SkyDashNET on Saweria" src="https://img.shields.io/badge/Support-Saweria-FAAE2B?style=for-the-badge&labelColor=173F35"></a>
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

TR69 Controle is a management layer for GenieACS deployments. It combines an operator-facing panel on port `5890` with an isolated customer portal on port `5891`. SQLite works out of the box, while MySQL can be selected and migrated to later from the interface.

| Operator console | Customer portal |
| --- | --- |
| Fleet health, faults, optical signal, temperature, and registration trends | ONT health, optical signal, uptime, and connected-device visibility |
| ONT, OLT, ODC, and ODP topology management with a network map | Permanent Customer IDs bound to SoftwareVersion and PPPoE identity |
| Multi-vendor WAN, WiFi, credential, and virtual-parameter configuration | Safe SSID and WiFi password changes for the authenticated customer's ONT |
| Per-customer portal passwords that operators can reveal or regenerate | Portal sign-in with a credential independent of the Customer ID |
| Runtime SQLite-to-MySQL migration and deployment controls | No WAN or administrative credential exposure |

## Highlights

- Dedicated operator and customer listeners served by one application.
- First-run setup wizard for the initial administrator account.
- Fast Vite and React interface with responsive light and dark themes.
- Multi-language interface in Portuguese (Brazil), English, Spanish, Italian, German, French, Japanese, Simplified Chinese, Traditional Chinese, Korean, Russian, Arabic — with full right-to-left layout — and Hindi, for both the operator panel and the customer portal.
- GenieACS fault visibility and dependency-light dashboard charts.
- Network topology editor with Google Maps and OpenStreetMap-compatible providers.
- Automatic Customer ID generation that can be enabled or disabled in Settings.
- Independent portal passwords per customer, generated automatically and rotatable from the device page.
- Operator accounts with an administrator and a read-only role.
- Server-side paging, search and status filtering for large ONT fleets.
- Encrypted recovery of the last WiFi password changed through the customer portal.
- SGP integration for subscriber contract, plan, and open-invoice data, with fleet-wide synchronization, contract-state filtering, and optional invoice display and trust unlock in the customer portal.
- Automatic activation of a new ONT from its SGP contract, with per-step run history and a dry run before anything is written.
- SGP event handling through a signed webhook and periodic contract reconciliation.
- Support tickets opened in SGP from an ONT's page, seeded with the equipment and its current optical reading, off by default because it writes to the ERP.
- Optical power, temperature and uptime recorded over time, charted on each ONT's page so a slow decline is legible before it becomes an outage.
- ONT replacement detected from the subscriber's identity, with the SGP contract link carried onto the new equipment and the swap raised for the operator.
- Automatic Linux dependency and Node.js installation during both first install and CLI updates.

## Screenshots

<div align="center">
  <table>
    <tr>
      <td align="center"><strong>Operator panel</strong></td>
      <td align="center"><strong>Customer portal</strong></td>
    </tr>
    <tr>
      <td><img src="docs/screenshots/operator-panel.png" alt="TR69 Controle operator access screen" width="680"></td>
      <td><img src="docs/screenshots/customer-portal.png" alt="TR69 Controle customer portal access screen" width="680"></td>
    </tr>
    <tr>
      <td align="center"><sub>Secure access to fleet operations and GenieACS management.</sub></td>
      <td align="center"><sub>Isolated self-service access for each authenticated customer.</sub></td>
    </tr>
  </table>
</div>

## Installation

The production installer targets Linux systems running `systemd`. It supports:

- Debian and Ubuntu
- Fedora, RHEL, Rocky Linux, and AlmaLinux
- Arch Linux
- openSUSE

Git, native build tools, and the latest Node.js 22 release are installed automatically when required. An existing Node.js 22.22 or newer installation is reused.

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
| `skygenpanel reset-password <user>` | Reset an operator password; prompts securely (or reads `RESET_PASSWORD`) — never pass it as an argument |
| `skygenpanel reset-mfa <user>` | Turn off two-step login for someone who lost their phone and recovery codes, and end their sessions |
| `skygenpanel backup` | Take a backup now: database, WhatsApp attachments, and the fingerprint of the encryption keys |
| `skygenpanel backup verify` | Report how old the newest backup is and whether the keys still match the ones it was taken with |
| `skygenpanel rotate-key [--dry-run]` | Rewrite every stored secret with the live `SECRET_BOX_KEY`; `--dry-run` counts them per key version without writing |

The installer also schedules `skygenpanel-backup.timer` to run daily at 03:17 (with a
randomized delay, and `Persistent=true` so a machine that was off catches up instead of
skipping the day). Copies land in `/var/backups/skygenpanel` — thirty daily, plus the
Sunday one of each of the last fifty-two weeks. Override the destination and the counts
with `SKYGP_BACKUP_DIR`, `SKYGP_BACKUP_KEEP_DAILY` and `SKYGP_BACKUP_KEEP_WEEKLY`.

A backup does not include `backend/.env`. It records a **fingerprint** of `SECRET_BOX_KEY`
and `JWT_SECRET` instead, because those two are what decrypt every stored secret: restore
the database with the wrong ones and the panel boots, answers 200, and every portal
password, WiFi password and API token reads back as null. Keep the keys in your own vault,
and let `skygenpanel backup verify` tell you whether the ones on the machine still match
the ones your newest backup was taken with. `SKYGP_BACKUP_INCLUDE_SECRETS=1` puts the
`.env` in the backup directory in the clear — only do that if the destination is itself
encrypted, since the backup would then carry the master key and the database password
alongside the data.

## Cloudflare Tunnel

When `cloudflared` runs on the TR69 Controle host, publish two HTTP services:

| Public hostname | Origin service |
| --- | --- |
| `panel.example.com` | `http://127.0.0.1:5890` |
| `portal.example.com` | `http://127.0.0.1:5891` |

TLS terminates at Cloudflare, so the local origin URLs intentionally use HTTP. Keep Universal SSL active for the zone and wait for its edge certificate to reach `Active` before forcing HTTPS redirects.

## GenieACS behind NAT: the agent

The panel reaches each provider's GenieACS NBI in one of three modes, chosen per provider
(in the platform console on the hosted edition, under the provider's Settings on a
self-hosted install):

| Mode | Use it when |
| --- | --- |
| **Direct** | The NBI (port 7557) is reachable from the panel |
| **Tunnel** | The NBI sits on a private network the panel reaches through a VPN/WireGuard link (hosted edition) |
| **Agent** | The NBI has no public address and nobody wants to open a port |

In agent mode a small program runs on a machine inside the provider's network, opens an
**outbound** WebSocket to the panel, and relays the panel's NBI requests to the local
GenieACS. Nothing on the provider's side is exposed.

1. Switch the provider to **agent** mode and generate a key. The `sgpa_…` key is shown
   **once**; the panel keeps only its hash.
2. On a Debian/Ubuntu or RHEL-family machine with systemd that can reach the GenieACS:

   ```bash
   curl -fsSL https://panel.example.com/api/genieacs-agent/install.sh | sudo bash
   ```

   The installer comes from the panel itself, so the agent always matches the panel's
   version. It installs Node.js 22 if needed, asks for the key without echoing it (read
   from the terminal, not from the pipe), asks for the NBI address (default
   `http://127.0.0.1:7557`) and tests it, then starts the hardened
   `skygenpanel-agent` service. For unattended runs, pass the key through a file:
   `… | sudo AGENT_TOKEN_FILE=/root/agent-key bash`. The key is never accepted as an
   argument or through `AGENT_TOKEN`: command lines are visible to every local user.

| Task | How |
| --- | --- |
| Follow the log | `journalctl -u skygenpanel-agent -f` |
| Rotate the key | Generate a new one in the panel (the current connection drops), then re-run the installer and answer **n** to "keep the current key?", or edit `AGENT_TOKEN=` in `/etc/skygenpanel-agent.env` (root, `0600`) and `systemctl restart skygenpanel-agent` |
| Update the agent | Re-run the installer; the stored key and addresses are kept |
| Uninstall | `curl -fsSL https://panel.example.com/api/genieacs-agent/install.sh \| sudo bash -s -- --uninstall` |

Two things the deployment must provide:

- **The reverse proxy must pass the WebSocket upgrade** on
  `/api/genieacs-agent/connect`. A typical `location /` block sets `Connection ""` for
  upstream keep-alive, which strips the upgrade and leaves the agent with a 426. The nginx
  examples in `deploy/proxy/` carry a dedicated `location = /api/genieacs-agent/connect`
  block (`Upgrade`, `Connection "upgrade"`, one-hour timeouts); copy it into any proxy
  configured before this release. Cloudflare Tunnel passes WebSockets as is.
- **A single panel replica.** An agent's connection lives in the process that accepted
  it; behind a load balancer with two replicas, half of the requests would land where the
  agent is not and fail with `acs_agent_offline`.

The installer's default `PANEL_URL` comes from `TENANT_BASE_DOMAIN` (the provider's own
subdomain) or `PUBLIC_BASE_URL`, never from the request's `Host` header; with neither set,
it asks. Operations detail: [`docs/saas-operations.md` §12](docs/saas-operations.md).

## Configuration

Environment configuration lives in `backend/.env`; see [`backend/.env.example`](backend/.env.example).

| Variable | Purpose |
| --- | --- |
| `APP_HOST` | Operator panel bind address |
| `APP_PORT` | Operator panel port; defaults to `5890` |
| `PORTAL_HOST` | Optional customer portal bind address |
| `PORTAL_PORT` | Customer portal port; defaults to `5891` |
| `JWT_SECRET` | Stable application secret used for operator and customer sessions |
| `PORTAL_JWT_SECRET` | Optional independent customer-session secret |
| `SECRET_BOX_KEY` | Encrypts the secrets an operator can read back (portal and WiFi passwords, SGP and WhatsApp tokens); falls back to `JWT_SECRET` when unset |
| `EDITION` | `selfhosted` (default) or `saas`; the hosted edition withdraws the runtime database switcher |
| `TENANT_BASE_DOMAIN` | Hosted edition: the domain each provider's panel hangs off (`alfa.painel.example.com`). Its apex is the platform console, which belongs to no provider. Unset means one host for everything |
| `PORTAL_BASE_DOMAIN` | Hosted edition: the same for the subscriber portal |
| `CORS_ORIGINS` | Explicitly allowed browser origins |
| `DATA_DIR` | Optional persistent application data directory |
| `TRUST_PROXY` | Number of trusted proxy hops in front of the panel; `1` for the default reverse-proxy or Cloudflare Tunnel deployment, `0` when the listeners are exposed directly |
| `PORTAL_COOKIE_SECURE` | `auto` (default), `true`, or `false`; overrides the portal cookie `Secure` flag when a proxy terminates TLS without advertising it |

The GenieACS URL and optional MySQL connection are managed from the Settings interface rather than environment variables. Runtime database configuration is stored in `DATA_DIR/db-config.json`.

### Rotating `JWT_SECRET`

`SECRET_BOX_KEY` exists so that rotating `JWT_SECRET` does not destroy stored
data. Until it was introduced, session signing and secret encryption derived
from the same value, and decryption reports failure by returning nothing — so a
rotation quietly turned every portal password, saved WiFi password, provisioning
password and integration token into an unreadable blob.

Each encrypted secret now records which key wrote it, so both keys are readable
side by side. `install.sh` generates `SECRET_BOX_KEY` for new installs and adds
one to an existing `.env` on update, which is safe: data already stored stays
readable through `JWT_SECRET`, and only new writes use the dedicated key.

Anything written before `SECRET_BOX_KEY` was configured remains tied to
`JWT_SECRET` until it is written again. Regenerating a customer's portal
password, or re-saving a provisioning profile or WhatsApp instance, moves that
secret onto the new key.

For those rows, set `JWT_SECRET_PREVIOUS` to the old value before rotating
`JWT_SECRET`. Each key version accepts more than one key: the live one writes,
and the previous one is only ever tried on the way in, so every stored secret
stays readable until it is next written. `SECRET_BOX_KEY_PREVIOUS` does the same
for the dedicated key.

```bash
JWT_SECRET_PREVIOUS=<the value being replaced>
JWT_SECRET=<the new value>
```

### Finishing a rotation

`skygenpanel rotate-key` is the step that rewrites the secrets already stored,
so a rotation stops depending on anyone re-saving each one by hand. Run it with
both keys present — the new one live, the old one in `*_PREVIOUS` — and it moves
every stored secret onto the live key:

```bash
skygenpanel rotate-key --dry-run   # counts what is stored, per key version
skygenpanel rotate-key
```

It refuses rather than guesses: a secret it cannot decrypt with any key this
process has stops the run and nothing is rewritten. That case means the key that
wrote it is missing from the environment, and finding that out before the old
key is discarded is the whole point.

Two things it does NOT make safe, which is why they are written here:

- **The backups.** Every backup records a fingerprint of `SECRET_BOX_KEY` and
  `JWT_SECRET`, and `skygenpanel backup verify` refuses a restore whose key no
  longer matches. The default retention keeps thirty daily and fifty-two weekly
  copies — about a year, all taken with the old key. Rewriting the live database
  does nothing for them: **file the previous key with those dumps** before
  removing it from `.env`.
- **Version 1 rows**, which derive from `JWT_SECRET` rather than
  `SECRET_BOX_KEY`. Keep `JWT_SECRET_PREVIOUS` set while the command runs, or it
  will refuse on the first one it meets.

Drop `JWT_SECRET_PREVIOUS` and `SECRET_BOX_KEY_PREVIOUS` once the command has
run AND the backups taken before it have aged out of retention. Leaving them set
keeps the old keys usable, which is the point during a rotation and not after
one.

## Customer Portal Credentials

Each customer account carries its own portal password. The Customer ID identifies
the account; it is never the credential for it.

- A password is generated automatically when an account is created.
- Open a device in the operator panel and use **Customer access → Portal password**
  to reveal the current password or generate a new one.
- Passwords are stored as a bcrypt hash for authentication plus an AES-256-GCM
  encrypted copy so staff can read one back without disrupting the customer.

Accounts created before this release authenticated with the last six characters of
their own Customer ID. On the first start after upgrading, every one of them
receives a freshly generated password in the background, and the log reports how
many were issued. Reveal the new password from the device page before sharing it —
the old one no longer works.

## Customer Account Lifecycle

A customer account is bound to an ONT, and the **PPPoE login is what identifies
the subscriber** behind it. The software version is not: a firmware upgrade
refreshes the stored identity in place and changes nothing else.

- **Replacement ONT, same subscriber** — the account, Customer ID and portal
  password follow the subscriber to the new device.
- **Same ONT, new subscriber** — when the fleet sync sees a device reporting a
  different PPPoE login, the previous account is *retired*: it is deactivated,
  its Customer ID and portal password stop working, and its SGP contract link is
  dropped. The incoming subscriber gets a fresh account. Without this the new
  occupant of a recycled ONT would inherit the previous customer's Customer ID,
  portal password, saved WiFi credentials, and their contract, plan and open
  invoices from SGP.

Retirement is destructive, so it is logged at warning level with both PPPoE
logins:

```
Device <id> now reports PPPoE "b@isp" instead of "a@isp"; retiring customer account CSG-…
```

Watch that line after changing the `vpPppoeUsername` virtual parameter — a
misreported login there is the one way a live customer could be retired by
mistake. Retired rows are kept in `customer_accounts` with `active = 0`, so a
mistake can be inspected and undone in the database.

## Operator Accounts

**Settings → Operators** (administrators only) manages who can sign in to the
panel. Two roles exist:

| Role | May do |
| --- | --- |
| `admin` | Everything, including settings, device changes, the database, SGP and operator management |
| `viewer` | Read the dashboard, the device list and GenieACS faults; every administrative route answers `403` |

The panel always keeps at least one administrator: the last one cannot be
demoted or deleted, and you cannot demote or delete the account you are signed
in with. Changing an operator's role or password revokes their existing sessions
immediately.

A viewer sees only the dashboard and the device list; the network map and
settings are hidden from the navigation and redirect to the dashboard if the
URL is entered directly. The backend enforces the same boundary independently,
so the UI is a convenience rather than the control.

## SGP Integration

Open **Settings → SGP integration** (*Integração SGP*) to connect the panel to
[SGP](https://sgp.net.br) and show contract, plan, and open-invoice data next to
each ONT. The integration token is encrypted with `JWT_SECRET` and never leaves
the server.

A fleet synchronization links every ONT to its contract in one pass, after which
the device inventory can be filtered by contract state and the dashboard reports
the divergences neither system sees alone: an ONT answering while its contract is
blocked or cancelled, a contract that is active while the ONT stays silent, and a
device with no contract linked. See
[`docs/sgp-integration.md`](docs/sgp-integration.md) for setup, endpoints, and
troubleshooting.

The same tab receives events from SGP — a signed webhook when the provider's
install can push one, and periodic reconciliation of the linked contracts when
it cannot — so a payment, a block, or a cancellation reaches the panel and the
customer portal without anyone reloading a page.

Invoices are always read live from SGP. The contract behind a device (holder,
plan, status) is cached for 24 hours and re-read after that, and a cached link
recorded for a different customer account than the device currently serves is
discarded rather than shown.

### New clients from the Contacts screen

**New client** (*Novo cliente*) starts with the CPF or CNPJ:

- If the client is already in SGP, the panel opens their record instead of creating a duplicate.
- When nobody has the document yet and TeiaH Valid is configured, the form is filled from TeiaH's
  `POST /api/whatsapp/consulta-cpf` (name, birth date, e-mail, phone, address) and its score is
  shown. Only the fields the form uses reach the browser; the lookup is recorded in the audit
  trail without the document. A company TeiaH does not know is filled from the Receita.
- The postal code fills the street, district, city and state.
- With **Also register in SGP**, the client is created in SGP first through
  `POST /api/crm/cliente/F` or `/J`, without a contract, and filed in the panel under SGP's own
  client id, so the contacts sync does not duplicate it. This needs both `contacts.edit` and
  `sgp.act`.

### TeiaH on the client record

On a client's record (needs `contacts.edit` and `teiah.act`), the **TeiaH Valid** card asks the TeiaH
about the client's CPF/CNPJ and keeps the answer on the record: score and risk, the mother's name,
the other addresses, and every phone and e-mail it has. Nothing is merged on its own. **Add to the
record** puts the phones and e-mails the record lacks into the client's fields (as an edit the
operator can restore) and gives a contract with no WhatsApp number the first mobile; nothing already
there is removed or replaced. The answer is personal data: it is part of the client's data export and
is deleted with the client.

## TeiaH Valid Integration

Open **Settings → TeiaH Valid** to send the addresses of contracts that were
cancelled with invoices still open to [TeiaH Valid](https://valid.teiah.ai), a
shared base that other providers check before activating a customer at the same
address. The provider's API key (`x-api-key`) is encrypted like the SGP token.

The export works from the SGP integration. Its candidates are the cancelled
contracts that the SGP contacts sync already stored. For each one, the panel
adds up the open invoices in SGP and sends an `ImportAddressDto` to
`POST /api/import/addresses` with these fields:

- the street, number, district, city, state and postal code;
- the coordinates, when SGP has them;
- the amount owed;
- the start and cancellation months;
- `aluguel`, whether the equipment stayed with the customer on rent or loan
  (comodato). It comes from the contract's own field in SGP when there is one;
  otherwise the tab's default applies, which is to leave the field out.

Name, tax ID, phone and contract number are never sent. A contract without a
complete address, a start date, a cancellation date or any debt is skipped and
listed with the reason. A contract already sent with the same content is not
sent again. The export can run on a schedule or from the **Send now** button, and
**Preview** shows the payloads without sending anything.

## Automatic activation

Open **Settings → Automatic activation** to let a newly installed ONT configure
itself. The panel resolves the SGP contract from the PPPoE login the ONT already
reports, applies the profile matching the contract's plan (WiFi, administrative
password, PPPoE WAN, VLAN), and records every step so a failed activation can be
diagnosed. It is off by default, and every action has a dry run. See
[`docs/provisioning.md`](docs/provisioning.md).

## Database Migration

Open **Settings → Database** as an administrator to:

1. Inspect the active database configuration.
2. Test a MySQL connection.
3. Migrate existing application data.
4. Switch the running application to the new database.

The migration includes device installation profiles, related customer accounts, encrypted customer WiFi credentials, SGP contract links, provisioning profiles and their run history, and stored SGP events.

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
npm run check:backend   # syntax-check every backend module
npm run test:backend    # operator and customer portal integration tests
npm run lint
npm run typecheck
npm run build
npm run verify          # all of the above, the same sequence CI runs
```

Build and run the production bundle locally:

```bash
npm run build
npm start
```

## Languages

The operator panel and the customer portal ship with Portuguese (Brazil),
English, Spanish, Italian, German, French, Japanese, Simplified Chinese,
Traditional Chinese, Korean, Russian, Arabic, and Hindi. The active language
follows the browser preference on first load and falls back to Portuguese
(Brazil); the choice is stored per browser in `localStorage` under the
`language` key.
Operators change it from the sidebar or from **Settings → Panel & ACS**, and
subscribers change it from the portal header. Dates and numbers follow the
active locale and the viewer time zone.

Arabic is right-to-left. Selecting it sets `<html dir="rtl">`, and the whole
interface mirrors: the layout is written with CSS logical properties
(`ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`), so margins, padding,
absolute positioning and text alignment follow the writing direction instead of
a fixed side. Adding another RTL language needs only a `direction: 'rtl'` entry
in `LOCALE_METADATA`.

API responses follow the same language. The panel and the portal send the
active locale in `Accept-Language`, the backend negotiates it per request
(falling back to Portuguese), and every response carries `Content-Language`
plus `Vary: Accept-Language` so a proxy never serves one language to a client
that asked for another.

Translations live in `frontend/src/lib/i18n/locales/` for the interface and
`backend/src/i18n/locales/` for the API messages. In both places `en` is the
source of truth: the frontend dictionaries are typed against it, so
`npm run typecheck` fails whenever a key is added without a translation in
every language, and `npm run test:backend` fails on the same gap for the API
dictionaries. To add a language, create a locale file on both sides, register
it in `frontend/src/lib/i18n/config.ts` and `backend/src/i18n/config.js`, and
add it to `dictionaries` in the matching `index` module.

Text that SGP or GenieACS itself returns is passed through as the provider
phrased it, since only the provider can translate it.

## Architecture

- **Backend:** Node.js, Express 5, Knex, SQLite, MySQL, and JWT.
- **Schema:** ordered, recorded migrations in `backend/src/config/migrations.js`; every applied step is stored in a `schema_migrations` table, and a database created before the runner existed is baselined on first boot rather than rebuilt.
- **Frontend:** Vite, React, React Router, TypeScript, and Tailwind CSS.
- **Deployment:** `systemd`, hardened service boundaries, automatic dependency installation, and an update-safe CLI.
- **Integration:** GenieACS NBI with typed task values and multi-vendor parameter discovery.

The operator and customer APIs use separate listeners. Administrative routes are not mounted on the customer portal port.

## Security

- Role-based operator access with bcrypt password hashing and separate access and refresh tokens.
- Per-customer portal passwords, bcrypt hashed and independent of the Customer ID.
- Customer sessions stored in `HttpOnly`, `SameSite=Strict` cookies.
- Customer actions resolve the target device exclusively from the authenticated account.
- Saved WiFi passwords protected at rest with authenticated AES-256-GCM encryption.
- Password values revealed only through an authenticated, rate-limited request.
- Same-origin mutation checks, strict CSP, security headers, and request-size limits.
- Dedicated rate limits for login, portal API access, WiFi mutations, and password reveals.
- Authenticated portal limits keyed per customer account, so one visitor cannot exhaust the quota for the rest of the customer base behind a shared proxy address.
- Session revocation after operator password changes, role changes and logout.
- A recycled ONT retires the previous subscriber's account instead of handing it to the next one.
- Internal error text is returned only when `APP_ENV=development` is set explicitly.
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
  -e PORTAL_JWT_SECRET="$(openssl rand -hex 48)" \
  -e SECRET_BOX_KEY="$(openssl rand -hex 48)" \
  skygenpanel
```

The image defaults to the self-hosted edition on SQLite. Point it at a server with
`DATABASE_URL` (`postgres://user:pass@host:5432/db?schema=panel&sslmode=require`, or
`mysql://…`), which takes precedence over `db-config.json`. The hosted edition —
`EDITION=saas`, providers by subdomain, a managed Postgres, logs and metrics per provider —
is set up and operated as described in [docs/saas-operations.md](docs/saas-operations.md);
`deploy/docker-compose.saas.yml` is its starting point. Where the DNS provider offers no API
— so no automatically renewed wildcard certificate — `deploy/novo-provedor.sh <slug>` issues
one certificate per provider and installs its nginx block.

## License

TR69 Controle is available under the [MIT License](LICENSE).

For support, email [support@skydash.net](mailto:support@skydash.net) or open a [GitHub issue](https://github.com/skydashnet/genieacs-panel/issues).

<div align="center">
  <sub>© 2024–2026 SkydashNET</sub>
</div>
