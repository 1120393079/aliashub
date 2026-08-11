# AliasHub deployment

This guide covers a clean self-hosted installation. A release must not contain
source accounts, messages, verification codes, OAuth tokens, production
configuration, connector keys, SUB2 credentials, or registration-worker tokens.

## Requirements

Recommended:

- Linux with Docker Engine and Docker Compose v2.24 or newer
- Internet access while the container image and dependencies are built
- For full mode, enough disk and memory for Chromium, Playwright, Camoufox, and
  the headed browser and Pickup storefront runtimes; the images are
  substantially larger than core mode

Native alternative:

- Linux with Node.js 18 or newer (Node.js 22 LTS recommended) and npm
- Python 3, `make`, and a C++ compiler when a prebuilt `better-sqlite3` binary is
  unavailable

To connect iCloud Mail, the AliasHub process or container also needs outbound
TCP access to `imap.mail.me.com:993`. The IMAP hostname, port, TLS requirement,
and certificate verification are fixed in the backend and cannot be overridden
from the browser.

## Core Docker Compose

```bash
./scripts/setup-local.sh
docker compose up -d --build
docker compose ps
```

The setup command creates `.env`, generates independent credentials, and prints
the administrator password once. Open `http://127.0.0.1:4180` and sign in as
`admin` unless `ADMIN_USERNAME` was overridden during setup.

Useful commands:

```bash
docker compose logs -f
docker compose restart
docker compose down
```

Core mode deliberately leaves `REGISTRATION_SERVICE_URL` and
`REGISTRATION_MAILBOX_URL` empty. Automatic registration is disabled, but all
mailbox, alias, address, verification-code, and connector features remain
available.

## Full suite Docker Compose

The repository includes the complete registration worker, browser runtime, and
Mail Pickup source. Start all three services with the full override:

```bash
./scripts/setup-local.sh --full
docker compose -f compose.yaml -f compose.full.yaml up -d --build
docker compose -f compose.yaml -f compose.full.yaml ps
```

The first worker image build can take considerably longer than the AliasHub
build because it installs multiple browser engines. The local endpoints are:

- AliasHub: `http://127.0.0.1:4180`
- Registration worker UI/API: `http://127.0.0.1:8000`
- Registration browser/noVNC: `http://127.0.0.1:6080/vnc.html`
- Mail Pickup buyer/admin service: `http://127.0.0.1:4190`

The worker UI uses `REGISTRATION_SERVICE_TOKEN` as its login password. The full
Compose override passes that exact value as worker `APP_PASSWORD`, so the worker
and AliasHub cannot accidentally use different tokens. noVNC uses the separate
`REGISTRATION_VNC_PASSWORD`. Pickup uses generated `PICKUP_INBOUND_TOKEN` and
`PICKUP_TOKEN_SECRET` values and defaults to the AliasHub administrator login.
All of these values are stored only in `.env`.

Use the same two Compose files for every lifecycle command:

```bash
docker compose -f compose.yaml -f compose.full.yaml logs -f
docker compose -f compose.yaml -f compose.full.yaml restart
docker compose -f compose.yaml -f compose.full.yaml down
```

## Native Node.js

```bash
npm ci
npm run build:local
./scripts/setup-local.sh --native
./scripts/start-local.sh
```

The server stays in the foreground. Stop it with `Ctrl+C`. Native mode starts
AliasHub core only; use the full Docker Compose command when the bundled worker
and browser runtime are required.

## Remote server

The supplied Compose files publish AliasHub, the worker UI/API, noVNC, and Mail
Pickup only on the server's loopback interface. Keep those bindings and place
Caddy, Nginx, Traefik, or another HTTPS reverse proxy in front of only the
endpoints that must be reachable remotely.

Before starting the service, set the public HTTPS URL in `.env`:

```dotenv
PUBLIC_BASE_URL=https://aliashub.example.com
PICKUP_PUBLIC_BASE_URL=https://pickup.example.com
PICKUP_EMAIL_DOMAIN=mail.example.com
```

Use a dedicated hostname when possible. The supplied container image is built
for the URL root; serving it below a path prefix requires a frontend build with
the matching `VITE_BASE_PATH` and corresponding reverse-proxy routing. Do not
expose the SQLite database, `.env`, attachments directory, registration worker,
or browser/noVNC control ports directly to the internet.

For full mode, the worker calls AliasHub over the Compose network at
`http://aliashub:4180`; it must not use `127.0.0.1`, because loopback inside the
worker container refers to the worker itself. The default noVNC link is a local
loopback URL. For remote browser access either use an SSH tunnel, or publish it
behind HTTPS and additional access control and set its browser-visible URL:

```dotenv
REGISTRATION_BROWSER_URL=https://browser.example.com/vnc.html?autoconnect=true&resize=scale&path=websockify
```

The host ports remain loopback-bound even after this setting changes. Configure
the reverse proxy to forward to `127.0.0.1:6080`; do not change the Compose port
binding to `0.0.0.0`.

The advanced `scripts/deploy-production.sh` helper is for an existing systemd
installation. It has no private deployment defaults; all target paths and the
service name must be supplied explicitly. Docker Compose users do not need it.

## Configuration and data

- Runtime configuration and encryption keys: `.env`
- AliasHub SQLite database and attachments: `data/`
- Full-mode worker SQLite database: `data/registration-worker/`
- Full-mode Mail Pickup database and browser profile: `data/mail-pickup/`
- Default bind addresses: `127.0.0.1:4180`, and in full mode also
  `127.0.0.1:8000`, `127.0.0.1:6080`, and `127.0.0.1:4190`
- Demo data: disabled

Keep `.env` and `data/` together in every backup. Changing or losing
`DATA_ENCRYPTION_KEY` makes previously encrypted OAuth tokens, iCloud
App-specific passwords, inbox-link keys, and service credentials unreadable. Store backups
outside the web root and encrypt them. Set `DATA_ENCRYPTION_KEY` before adding
iCloud Mail or binding dispose.lol inbox links; AliasHub refuses credential
storage when it is unset.

Changing or losing `PICKUP_TOKEN_SECRET` invalidates existing buyer pickup
links and prevents decryption of saved storefront credentials. Treat it as part
of the same backup set as `.env` and `data/mail-pickup/`.

To use a different local port before the first start:

```bash
PORT=4280 PUBLIC_BASE_URL=http://127.0.0.1:4280 ./scripts/setup-local.sh
```

## Registration worker configuration

`compose.full.yaml` supplies these container-network values automatically:

```dotenv
REGISTRATION_SERVICE_URL=http://registration-worker:8000
REGISTRATION_MAILBOX_URL=http://aliashub:4180
```

Do not copy those internal hostnames into a non-Compose deployment. If AliasHub
and the worker are deployed separately, set URLs that are reachable from the
calling service, keep `REGISTRATION_SERVICE_TOKEN` identical to worker
`APP_PASSWORD`, and protect the connection with a private network or HTTPS.

The worker automatically receives the AliasHub mailbox endpoint and a
server-side mailbox API credential when a registration job is started. Configure
deployment-specific proxy, SMS, and other optional providers in the worker UI.
No provider credential is included in the repository.

Advanced worker-only environment options are documented in
`registration-worker/.env.example`. If needed, copy that file to
`registration-worker/.env`; full Compose loads it when present. Values in this
optional file cannot override the shared `APP_PASSWORD`, `VNC_PASSWORD`, or
database path enforced by `compose.full.yaml`. Never commit the populated file.

## Mail Pickup configuration

Full Compose supplies internal service URLs automatically. Configure only your
deployment-specific public URL and inbound email domain in `.env`:

```dotenv
PICKUP_PUBLIC_BASE_URL=https://pickup.example.com
PICKUP_EMAIL_DOMAIN=mail.example.com
```

The setup script generates the inbound token and Pickup token secret. AliasHub
uses `http://mail-pickup:4190` inside Compose, and Mail Pickup uses
`http://aliashub:4180` plus a read-only mount of the AliasHub database. Do not
replace these internal names with host loopback addresses inside containers.

Storefront automation is optional. Configure the product ID, image URL, proxy,
or CDP endpoint through the documented `PICKUP_LDXP_*` and `LDXP_*` environment
variables, or connect the storefront from the Pickup administrator page. These
values and the Playwright browser profile are runtime data and must not be
committed. Native setup details are in `mail-pickup/README.md`.

## Optional SUB2-compatible service

SUB2 import is independent of mailbox OAuth and the registration-worker
connection. In AliasHub settings, enter the compatible service's base URL and
its Admin API Key, save, and run the connection test. The Key is encrypted in
the local database and is not included in `.env` or release archives.

Headless installations may instead set both server-side variables in their
uncommitted `.env`:

```dotenv
SUB2_BASE_URL=https://sub2.example.com
SUB2_ADMIN_API_KEY=replace-with-this-installation-admin-key
```

Environment values take precedence over web configuration and must be handled
as deployment secrets. Leave both empty by default.

If no SUB2-compatible service is configured, only SUB2 import is unavailable.
Do not use another installation's URL or administrator Key.

## Microsoft and Google authorization

Both providers use Authorization Code + PKCE. The callback is a loopback URL in
the user's browser; copy the complete callback URL from the address bar and paste
it into AliasHub when prompted. AliasHub validates the callback path and OAuth
`state` before exchanging the one-time code.

The included Microsoft identifier is a public desktop-client identifier, not a
client secret. Google requires the administrator to configure their own Client
ID and matching Client Secret through AliasHub settings or the variables in
`.env.example`.

## Optional Outlook browser connector

The connector is needed only for automatic official Outlook alias fill jobs.
Manual alias creation followed by manual registration in AliasHub does not need
it.

For a local installation, use the connector included in the release package. To
build one with permission for a remote AliasHub origin:

```bash
npm run package:extension -- "" "https://aliashub.example.com"
```

Then:

1. Extract `release/aliashub-outlook-extension.zip` to a permanent folder.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode and choose **Load unpacked**.
4. Select the extracted folder.
5. Copy the connector pairing key from AliasHub settings.
6. Enter the AliasHub URL and pairing key in the connector popup, then test the
   connection.

The build script refuses to embed the pairing key. Each user enters it locally
in the connector popup.

## Updating

For a Git-based installation, run the matching overwrite updater from the
repository root:

```bash
# Full suite Docker
./scripts/update-local.sh --full

# Core Docker
./scripts/update-local.sh --core

# Native
./scripts/update-local.sh --native
```

With no argument the updater detects a running Compose deployment and otherwise
uses native mode. Native users must stop their existing AliasHub process before
running it and restart that process after the build finishes.

The updater deliberately replaces tracked source files with `origin/main`, so
uncommitted source edits are not retained. It does not replace installation
state. Before fetching it stops the selected Compose services and creates a
timestamped backup under `deploy-backups/` containing:

- the root `.env` and optional `registration-worker/.env`;
- the complete `data/` tree, including AliasHub SQLite, attachments, and the
  full-mode worker and Mail Pickup databases, browser profiles, and state;
- SHA-256 manifests captured before and after the source replacement.

The command refuses to continue if the local environment or data paths are not
ignored by Git, and aborts if their manifests change. On a build/start failure
it keeps the backup and attempts to restart the previously selected Compose
mode. Do not move local databases, attachments, or credentials into tracked
source paths.

For an archive-based installation, stop the selected mode, back up the same
paths, replace only application source files, rebuild, and start it again. Never
overwrite `.env`, `registration-worker/.env`, or `data/` with archive contents.
