# AliasHub

AliasHub is a self-hosted mailbox and account-operations hub for Microsoft
Outlook, Google Gmail/Workspace, and Apple iCloud Mail accounts. It keeps
mailbox OAuth tokens, encrypted iCloud credentials, and service credentials on
the installation that you control.

## Features

- Connect multiple Microsoft and Google source mailboxes with OAuth, iCloud Mail
  with an Apple App-specific password, mail.com with its login password, and
  NetEase mailboxes with a client authorization code.
- Encrypt refresh tokens and all stored IMAP credentials at rest with
  AES-256-GCM.
- Read inbox messages, extract verification codes, search mail, and export
  address inventories.
- Manage Outlook official aliases and generate repeatable `+tag` addresses.
- Import NetEase `@163.com`, `@126.com`, or `@yeah.net` mother accounts with a
  client authorization code, map their `@aka.yeah.net` alias addresses, and use
  those addresses directly for registration and verification-code delivery.
- Mark addresses whose latest registration attempt failed, select every failed
  address in the current filtered inventory with one action, and remove the
  selected addresses in a guarded bulk operation.
- Run Outlook alias fill jobs through the optional Chrome/Edge connector.
- Coordinate account registration through the bundled optional registration
  worker, including browser/noVNC links, proxy selection, direct Microsoft
  base-address registration, and structured policy-failure reporting.
- Bind existing mailbox addresses to dispose.lol inbox links in the mailbox
  workspace, then allocate one saved mailbox per ChatGPT registration task.
  Inbox-link keys are encrypted in AliasHub and masked in API/UI responses.
- Refresh registered-account availability and plan type on demand, including
  Free, Go, Plus, Pro, Team, Business, Enterprise, Edu, Trial, and unknown
  future plans. Dynamic proxies are rechecked across independent sessions, and
  transient upstream failures preserve the last confirmed result.
- Refresh an existing account's Access Token from its authenticated web session
  or original-mailbox OTP login, and mark deleted or disabled accounts with a
  red `AT invalid` state. The refresh can reuse the original route or a selected
  saved proxy. Access-token recovery and new-account registration use independent
  worker lanes so one queue does not block the other.
- Group accounts automatically by detected plan or override groups manually in
  the account workspace, including bulk group edits and email search.
- Classify existing or newly created Checkout sessions as `cs_live` or `oaics`
  through a verified German exit, with cached-link reuse and account cooldowns;
  detect the Japanese Plus one-month trial offer through a verified Japan exit.
- Generate PayPal billing-agreement links directly from selected registered
  accounts through the bundled extractor, with independent Checkout and Update
  proxy pools and billing profiles for DE/EUR, TR/USD, and GB/GBP.
- Restore accounts removed from the worker's local account pool from JSON, CSV,
  JSONL, TXT, or email-only input while reconnecting their retained AliasHub
  registration and mailbox resources.
- Obtain Refresh Tokens through OpenAI OAuth, copy Access Tokens, and export
  selected accounts as SUB2 session JSON or Refresh Token JSON.
- Optionally import registered accounts into one SUB2-compatible service through
  OpenAI OAuth or a locally generated Ed25519 Agent Identity. Agent Identity
  imports validate the target account, use idempotent replay, recover ambiguous
  responses, and reject stale OAuth residue before activating the account.
- Run the bundled Mail Pickup storefront, publish source aliases or completed
  accounts, issue per-mailbox pickup links, expose the compatible latest-message
  API, and synchronize storefront inventory and sold status.

## What is included

This repository is the complete source distribution. It contains the AliasHub
web application and API, SQLite migrations, tests, Docker deployment files, the
Outlook browser connector, and the registration worker with its browser/noVNC
runtime under [`registration-worker/`](registration-worker/). It also includes
the complete Mail Pickup service, buyer/admin pages, tests, and storefront
automation under [`mail-pickup/`](mail-pickup/), plus the PayPal payment-link
extractor, API, and workbench under
[`payment-link-extractor/`](payment-link-extractor/).

“Complete” refers to the supported AliasHub core and full deployment paths.
The worker retains some upstream legacy or experimental routes whose separately
developed SDKs were not published in the pinned upstream source; those routes
are not used by AliasHub registration, mailbox, dynamic-proxy, password-setup,
or optional SUB2 integration flows.

The deployment remains modular:

- **Core mode** runs AliasHub only. Mailbox OAuth, message scanning, aliases,
  address generation, verification codes, and the browser connector all work.
- **Full mode** also runs the bundled registration worker, headed browser, Mail
  Pickup service, and payment-link extractor. It enables automatic account
  registration, direct PayPal link extraction, account and source-address
  publishing, buyer pickup links, and storefront synchronization without
  separately installing those services.

SUB2 is not a bundled service and is never required. Each deployment may connect
its own SUB2-compatible service URL and Admin API Key, or leave both empty.

## Quick start

Docker Compose is the recommended deployment path. For lightweight core mode:

```bash
./scripts/setup-local.sh
docker compose up -d --build
docker compose ps
```

For the complete suite with automatic registration:

```bash
./scripts/setup-local.sh --full
docker compose -f compose.yaml -f compose.full.yaml up -d --build
docker compose -f compose.yaml -f compose.full.yaml ps
```

Open `http://127.0.0.1:4180`. The setup script prints the generated administrator
password once and stores all deployment secrets in the local `.env` file. Full
mode also binds the worker UI to `127.0.0.1:8000`, noVNC to
`127.0.0.1:6080`, Mail Pickup to `127.0.0.1:4190`, and the payment-link
workbench to `127.0.0.1:18794`; none is exposed on a public interface by
default.

For native Node.js setup and remote-server deployment, see
[LOCAL-DEPLOY.md](LOCAL-DEPLOY.md).

For production maintenance, database snapshots, and the registration-pipeline
invariants, see [docs/SAFE-MAINTENANCE.md](docs/SAFE-MAINTENANCE.md).

To overwrite an existing Git-based installation with the latest source while
preserving local configuration and runtime data:

```bash
./scripts/update-local.sh --full
```

Use `--core` for the core Compose deployment or `--native` for a native
installation. The updater backs up and verifies the root `.env`, optional
`registration-worker/.env`, and complete `data/` tree before rebuilding.

## Development

```bash
cp .env.example .env
npm install
npm run dev
```

The Vite development server listens on port `5174`; the API listens on port
`4180`.

Run the verification suite before submitting a change:

```bash
npm test
npm run test:pickup
npm run build
python3 -c 'import ast,pathlib; [ast.parse(p.read_text(encoding="utf-8-sig"), filename=str(p)) for p in pathlib.Path("payment-link-extractor").rglob("*.py")]'
./scripts/check-public-release.sh
```

## OAuth configuration

### Microsoft

The default Microsoft public desktop client uses Authorization Code + PKCE and
requests `Mail.Read`, `User.Read`, and `offline_access`. A public desktop client
has no confidential client secret. After authorization redirects to the local
callback, paste the complete callback URL into AliasHub to finish the exchange.

Official alias creation is not available through Microsoft Graph. For automatic
official-alias fill jobs, build and load the optional connector:

```bash
npm run package:extension -- "" "http://127.0.0.1:4180"
```

The connector package does not embed its pairing key. Enter the AliasHub URL and
the installation-specific pairing key in the connector popup after loading it.

### Google

Google authorization uses Authorization Code + PKCE and requests `openid`,
`email`, `profile`, and `https://www.googleapis.com/auth/gmail.readonly`.
Before binding a Google account, configure your own OAuth Client ID and Client
Secret in AliasHub settings or through the matching variables in `.env`. The
redirect URI must exactly match `GOOGLE_OAUTH_REDIRECT_URI`.

Google accounts support the authenticated primary Gmail or Workspace address as
a base address for `+tag` generation. AliasHub does not create Google Workspace
administrator aliases.

### iCloud Mail

iCloud Mail uses Apple's fixed IMAP endpoint at `imap.mail.me.com:993` with TLS.
AliasHub accepts `@icloud.com`, `@me.com`, and `@mac.com` source addresses. In
your Apple Account, enable two-factor authentication and generate an
App-specific password, then enter that password in the iCloud connection form.
Do not enter your normal Apple Account password.

The App-specific password is sent only to the AliasHub backend, verified against
the fixed Apple endpoint, encrypted with AES-256-GCM, and never returned to the
browser. Set a unique server-side `DATA_ENCRYPTION_KEY` before connecting iCloud;
AliasHub refuses to store iCloud credentials without it. iCloud integration is read-only and supports inbox messages and
verification-code extraction. AliasHub does not generate iCloud aliases or
`+tag` addresses.

## Optional SUB2-compatible service

SUB2 integration is optional and disabled until an administrator configures it.
Each AliasHub installation supports one service connection:

- Base URL of a compatible service.
- Administrator API Key for that installation's service.

Configure the connection in AliasHub settings and run the connection test. The
API Key is sent only to the AliasHub backend, encrypted before it is stored in
SQLite, and never returned to the browser. Headless deployments may instead set
`SUB2_BASE_URL` and `SUB2_ADMIN_API_KEY` as server-side environment secrets;
leave both empty by default. Do not put an API Key in source code, an image, a
release archive, or a committed `.env` file.

The integration expects the SUB2-compatible administrative API used by this
project, including the OpenAI OAuth authorization-code exchange endpoints. A
product name is not used as a compatibility check. Without this configuration,
mailbox, alias, verification-code, and registration features remain available;
only SUB2 import is unavailable.

Agent Identity import additionally requires the compatible Codex-session import
endpoint and credential-merge behavior: explicit `null` OAuth token fields must
clear those tokens, omitted protected Agent Identity keys must remain stored,
and the account response must expose credential-status flags for final
verification. Implementations without that contract should keep Agent Identity
import disabled and use the OAuth flow instead.

## Mail Pickup

The bundled [`mail-pickup/`](mail-pickup/) service stores its own inventory and
messages in `data/mail-pickup/`. AliasHub's Sales page can publish eligible
source aliases, while the registered-account page can publish selected accounts
without sending Access Tokens. Mail Pickup supports HMAC pickup links, a buyer
mailbox, Basic-authenticated administration, the compatible `query.php` API,
Cloudflare-style inbound delivery, and optional storefront automation.

Full Compose mode connects both services automatically. Configure
`PICKUP_PUBLIC_BASE_URL` and `PICKUP_EMAIL_DOMAIN` for your deployment. The setup
script generates `PICKUP_INBOUND_TOKEN` and `PICKUP_TOKEN_SECRET`; it defaults
the Pickup administrator credentials to the AliasHub administrator credentials.
Storefront product IDs, image URLs, proxies, merchant sessions, and browser
profiles remain deployment-local and are never part of the source repository.

Native deployment and endpoint details are documented in
[`mail-pickup/README.md`](mail-pickup/README.md).

## PayPal payment-link extractor

The bundled [`payment-link-extractor/`](payment-link-extractor/) service accepts
one task per account from AliasHub, performs the Checkout/Update and provider
flows, and returns only a validated HTTPS PayPal billing-agreement URL. AliasHub
persists task progress and results, while Access Tokens and proxy credentials are
sent only over the private Compose network and are not written to the source
tree.

Full Compose mode configures the internal service URL and a generated shared
password automatically. In the AliasHub registration workspace, save separate
Checkout and Update proxy pools, choose DE/EUR, TR/USD, or GB/GBP, select any
number of registered accounts, and run **直接提链**. The standalone workbench and CLI
remain available for deployments that need them; see
[`payment-link-extractor/README.md`](payment-link-extractor/README.md).

## Data and secrets

Runtime state belongs in `.env` and `data/`; both are excluded from Git. Full
mode stores the worker database in `data/registration-worker/`, Pickup state in
`data/mail-pickup/`, and extractor logs under `data/payment-link-extractor/`.
Back up `.env` and the complete `data/` directory together. Losing
`DATA_ENCRYPTION_KEY` or `PICKUP_TOKEN_SECRET` makes encrypted OAuth tokens,
iCloud App-specific passwords, NetEase client authorization codes, inbox-link
keys, stored service credentials, or Pickup tokens unreadable.

Never commit:

- `.env`, databases, attachments, logs, backups, or browser profiles;
- OAuth tokens, callback URLs/codes, administrator passwords, or session keys;
- connector pairing keys, registration-worker or payment-extractor passwords,
  SUB2 API Keys, proxy subscriptions, or proxy credentials;
- mailbox inbox links or their embedded access keys;
- private deployment hostnames, addresses, or production configuration.

See [docs/RELEASING.md](docs/RELEASING.md) before making the repository public.

## Contributing and security

- Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Private vulnerability reporting: [SECURITY.md](SECURITY.md)

## License

AliasHub, the bundled registration worker, Mail Pickup, and payment-link
extractor are distributed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). See
[`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
