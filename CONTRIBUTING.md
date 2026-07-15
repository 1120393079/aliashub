# Contributing

## Development workflow

1. Create a focused branch from the current default branch.
2. Keep runtime data and credentials outside Git.
3. Add or update tests for behavior changes.
4. Run the project checks:

   ```bash
   npm test
   npm run build
   ./scripts/check-public-release.sh
   ```

5. Describe behavior changes, migrations, deployment impact, and verification in
   the pull request.

Do not commit generated `dist/`, release archives, dependency directories,
databases, attachments, browser profiles, logs, or local IDE configuration.

## Secret handling

Use placeholders such as `example.com`, documentation IP ranges, and
`replace-with-a-random-value` in examples and tests. Never submit a real mailbox,
password, OAuth token, callback code, proxy credential, connector key,
registration-worker token, SUB2 Admin API Key, or private deployment address.

If a secret is committed, stop using it and notify the repository owner through
the private process in [SECURITY.md](SECURITY.md). Rewriting Git history does not
replace credential rotation.

## Contribution license

AliasHub is licensed under `AGPL-3.0-only`. Unless explicitly agreed otherwise,
a contribution intentionally submitted for inclusion in this repository is
provided under the same license. Contributors must have the right to submit
their changes and must preserve applicable copyright, license, provenance, and
third-party notices.
