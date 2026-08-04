# Changelog

All notable changes to AliasHub are documented in this file.

## [1.2.0] - 2026-08-04

### Added

- Added pause, resume, and cancel-remaining controls in both AliasHub and the
  bundled worker, plus a persistent queue-wide pause that also holds newly
  submitted work and a queue-wide cancel action that preserves completed accounts.
- Added a mailbox-workspace page for binding `email + dispose.lol inbox link`
  rows and a matching ChatGPT registration source that allocates exactly one
  saved mailbox to each registration task.
- Added bundled-worker support for dispose.lol inbox-link message snapshots,
  new-message OTP polling, fixed-pool capacity checks, and per-task allocation.
- Added existing-account AT refresh through an authenticated web session or the
  original mailbox OTP login, deleted-account persistence, and a red `AT
  invalid` state in account and inbox-link views.
- Added independent registration and AT-recovery worker lanes, with AT recovery
  prioritized without bypassing per-account locking.
- Added local-account restoration from worker exports, JSON, JSONL, CSV, TXT,
  or email-only input, reconnecting retained registration and mailbox records.
- Added account email search, bulk group editing, OpenAI OAuth Refresh Token
  acquisition, and selected-account SUB2 and Refresh Token exports.
- Added a Git overwrite updater that backs up and verifies the root `.env`, the
  optional worker `.env`, AliasHub SQLite, attachments, worker data, and all
  other files under `data/` before rebuilding.

### Changed

- Synced the public web application and API with the complete account-operation
  interface while excluding only external pickup-store publishing.
- Removed deployment-specific NFapi defaults; compatible service and optional
  credential-reader connections now require explicit local configuration.

### Security

- Inbox-link keys are encrypted with AES-256-GCM in AliasHub, masked in API and
  UI responses, and omitted from registration logs and public test fixtures.

[1.2.0]: https://github.com/1120393079/aliashub/releases/tag/v1.2.0

## [1.1.0] - 2026-07-26

### Added

- Read-only Apple iCloud Mail support with encrypted App-specific passwords.
- Bundled Microsoft account registration runner, saved proxy management, and
  registration result ingestion.
- Registered-account availability and subscription-plan detection, automatic
  plan groups, and manual group overrides.
- Bulk SUB2-compatible imports through OpenAI OAuth or Ed25519 Agent Identity,
  including idempotent recovery and credential-state verification.
- Direct Microsoft base-address registration alongside the existing Plus-address
  mode, with duplicate-task protection and one-address-at-a-time validation.

### Changed

- Hardened administrator authentication, proxy handling, callback validation,
  secret redaction, and ambiguous upstream-response recovery.
- Captured structured account-creation responses from the registration worker
  and classified `registration_disallowed` as a stable policy failure instead
  of reporting it as a generic `about_you` form error.
- Split registration proxy, failure-classification, account-signal, NFapi,
  display, and form helpers into focused modules without changing API contracts.
- Reduced NFapi account state to `imported` or `not_imported`; incomplete and
  failed attempts remain session diagnostics and no longer create half-links.
- Expanded the public source distribution with the complete registration worker,
  deployment files, release checks, security policy, and third-party notices.

### Security

- Mailbox tokens, iCloud credentials, service API keys, and registration secrets
  remain server-side and encrypted at rest where persisted.
- Public examples no longer contain deployment-specific hostnames or credentials.
- Updated the web build chain, Electron runtime, and desktop packaging toolchain;
  the main AliasHub dependency audit now reports no known vulnerabilities.

[1.1.0]: https://github.com/1120393079/aliashub/releases/tag/v1.1.0
