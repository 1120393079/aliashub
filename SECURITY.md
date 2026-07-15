# Security policy

## Reporting a vulnerability

Do not publish credentials, OAuth callback URLs, tokens, mailbox content, or a
working exploit in a public issue.

Use the repository host's private security-advisory feature when it is enabled.
If private advisories are unavailable, contact the repository owner through a
private channel listed on their profile. Include:

- the affected version or commit;
- a minimal reproduction and the expected security boundary;
- the impact and any required configuration;
- whether credentials or user data may have been exposed.

The repository owner should add a dedicated security contact before public
release. Reports sent only through public issues may be removed to protect users.

## Deployment security

- Generate independent values for `ADMIN_PASSWORD`, `SESSION_SECRET`,
  `DATA_ENCRYPTION_KEY`, and `EXTENSION_API_KEY` per installation.
- Keep `.env`, `data/`, backups, and browser profiles outside the web root.
- Terminate TLS at a trusted reverse proxy for non-loopback deployments.
- Give registration workers and SUB2-compatible services unique, revocable
  credentials; never share administrator Keys between installations.
- Rotate a credential immediately if it appears in Git history, logs, screenshots,
  release archives, or support messages. Deleting the visible file is not enough.

Only the latest released patch version is expected to receive security fixes
until a formal supported-version policy is published.
