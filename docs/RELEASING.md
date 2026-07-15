# Public release checklist

Use this checklist for the source repository and every downloadable archive.

## 1. Verify licensing and notices

AliasHub is released under `AGPL-3.0-only`. Keep the unmodified license text in
the root `LICENSE` file and include it in every source or binary distribution.
Keep `THIRD_PARTY_NOTICES.md` with distributed artifacts.

The bundled `registration-worker/` is a modified derivative of
[sky3100/FrciblyK12](https://github.com/sky3100/FrciblyK12). Preserve its
`LICENSE` and `UPSTREAM.md`, include its complete corresponding source, and do
not remove upstream attribution. Review dependency licenses whenever bundled
dependencies or generated binaries change.

## 2. Remove deployment state

Confirm that the repository contains no:

- `.env` files other than `.env.example`;
- SQLite databases, attachments, logs, backups, browser profiles, or build
  artifacts;
- mailbox addresses or content, OAuth tokens/codes, session secrets, passwords,
  proxy credentials, connector keys, worker tokens, or SUB2 Admin API Keys;
- private hostnames, IP addresses, filesystem paths, service names, or production
  configuration.

Examples must use `example.com`, the RFC documentation address ranges, and
obvious placeholder credentials.

If a real credential was ever committed or included in an archive, rotate or
revoke it. Removing a file or rewriting history does not make the credential safe
to keep using.

## 3. Publish clean Git history

Do not push a development or production repository's existing history to a new
public remote. Old commits can retain deleted credentials and deployment data.

For the first public release, start from the reviewed clean tree and create a
fresh root commit, or use a reviewed history-rewrite procedure. Preserve the old
private repository separately. Inspect all branches, tags, pull-request refs,
Git LFS objects, releases, and CI artifacts before changing visibility.

## 4. Verify source and build

```bash
npm ci
npm test
npm run build
REQUIRE_LICENSE=1 CHECK_GIT_HISTORY=1 ./scripts/check-public-release.sh
```

If a release ZIP is needed:

```bash
npm run package:local
(cd release/local && sha256sum -c *.zip.sha256)
```

Extract the archive into a temporary directory and inspect it independently. Run
`scripts/check-public-release.sh` against the extracted directory as a final
content check.

The bundled checker catches forbidden file types, the known private deployment
identifier, and common token formats. It is a release gate, not a complete secret
detector. Review changes manually and use an additional history-aware scanner
such as Gitleaks in CI when available.

## 5. Validate a clean installation

Test every supported path from a machine without the maintainer's `.env` or
database:

- core Docker Compose on loopback;
- full Docker Compose with the bundled registration worker and noVNC ports still
  bound to loopback;
- the documented remote HTTPS reverse-proxy setup.

Verify mailbox OAuth, inbox scanning, address generation, connector pairing,
backup/restore, and upgrades. Test registration with newly issued non-production
fixtures. Confirm core mode remains fully usable without the worker and that
SUB2 remains disabled until each deployer supplies its own service URL and Admin
API Key.

## 6. Tag and publish

1. Update the version and release notes.
2. Commit the reviewed source tree.
3. Create a signed or annotated version tag.
4. Publish the source and checksummed artifacts.
5. Record supported upgrade paths and database migrations.
6. Keep private CI variables scoped, masked, protected, and revocable.
