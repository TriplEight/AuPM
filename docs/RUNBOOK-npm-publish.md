# Runbook: publish `aupm-cli` and `aupm-mcp` to npm

Design: [ADR 0017](adr/0017-publish-cli-with-trusted-publishing.md). Both packages share one
version. `aupm-mcp` publishes first.

## One-time steps (maintainer)

A trusted publisher can be set only for a package that exists. The first release of each name is
manual.

1. Log in to npm with an account that has 2FA: `npm login`.
2. Check out the release commit on `master`. Install: `pnpm install --frozen-lockfile`.
3. Pack both packages: `pnpm -C mcp pack --pack-destination "$TMPDIR/pack"` and the same for
   `cli`. Check the file lists with `tar tzf`. They hold `dist`, `README.md`, `LICENSE` and
   `package.json` only.
4. Publish in this order, with the 2FA code when npm asks:
   `npm publish "$TMPDIR/pack/aupm-mcp-0.3.0.tgz" --access public`, then
   `npm publish "$TMPDIR/pack/aupm-cli-0.3.0.tgz" --access public`.
   If `aupm-mcp` already has this version on npm (`npm view aupm-mcp versions`), skip its
   publish. A version cannot be published twice.
5. For each package, open `https://www.npmjs.com/package/<name>/access`. Under "Trusted
   Publisher" choose GitHub Actions and enter:
   - Organization or user: `TriplEight`
   - Repository: `AuPM`
   - Workflow filename: `publish-cli.yml`
   - Environment: leave empty
6. Optional: set "Require two-factor authentication and disallow tokens" for each package.
   Trusted publishing still works.

npm does not check the publisher settings when you save them. A wrong value fails at the first
tag release. The `repository.url` in each `package.json` must equal the GitHub repository.

## Release flow

1. On a branch, set the same `version` in `mcp/package.json` and `cli/package.json`. Merge it to
   `master` through a pull request.
2. Tag the merge commit and push the tag: `git tag cli-v<version>` and
   `git push origin cli-v<version>`.
3. The workflow `Publish CLI` runs. It fails at the first step if the tag does not equal both
   versions. It publishes with provenance. No npm token is stored anywhere.
4. Check: `npm view aupm-cli@<version> dist.attestations` and
   `npm install -g aupm-cli@<version> && aupm`.

A version cannot be published twice. After a failed run that published only `aupm-mcp`, bump both
versions and tag again.

## Requirements

- npm CLI 11.5.1 or later and Node 22.14.0 or later in the workflow, GitHub-hosted runners only.
  The workflow runs on Node 24.13.0, which ships npm 11.6.2.
- `id-token: write` on the publish job.
- Source: <https://docs.npmjs.com/trusted-publishers>.
