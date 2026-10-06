# `aupm` and `aupm-mcp` publish to npm through trusted publishing

Before this change, a user ran `aupm` from a clone through `tsx`. The GitHub Action built the CLI
from source. Both packages now publish to npm, so that `npm install -g aupm` works and the Action
can run a pinned, published package (L15).

Two packages publish, both at the same exact version: `aupm-mcp` (the MCP server and the donor and
attestation code) and `aupm` (the CLI, which depends on `aupm-mcp` at that exact version).

**Build.** Each package builds with `tsc` to `dist/`. The workspace keeps `exports` and `bin` that
point to `src/*.ts`, so tests and `tsx` need no build. `publishConfig.exports` (mcp) and
`publishConfig.bin` (cli) point to `dist`. `pnpm pack` applies them and replaces `workspace:*` with
the exact version. `npm pack` does not apply them, so the release uses `pnpm pack`. The cli build
maps `aupm-mcp/*` to `../mcp/dist/*` with `paths`, so it builds after the mcp build. A tarball
holds `dist`, `README.md`, `LICENSE` and `package.json`. It holds no `src`, no test and no
fixture.

**Release.** A tag `cli-v<version>` starts `.github/workflows/publish-cli.yml`. The workflow
checks that the tag equals both package versions, installs, typechecks and tests mcp and cli,
packs both, then runs `npm publish --provenance --access public` for `aupm-mcp` and then `aupm`.

**Credentials.** The workflow uses npm trusted publishing (OIDC). It has `id-token: write` and no
npm token secret. Trusted publishing needs npm CLI 11.5.1 or later and Node 22.14.0 or later
(<https://docs.npmjs.com/trusted-publishers>). Node 22 ships npm 10, so the release job runs on
Node 24.13.0, which ships npm 11.6.2. CI keeps testing on Node 22. The `repository.url` of each package must match the GitHub
repository exactly.
Provenance generation is automatic with trusted publishing; the workflow also passes
`--provenance`. A trusted publisher can be set only on a package that exists, so the first release
of each name is a manual publish by the maintainer (see `docs/RUNBOOK-npm-publish.md`).

We rejected a long-lived npm token in a repository secret: it can leak and it can publish from
any workflow. We rejected a bundler: `tsc` output keeps the packages readable and needs no new
dependency.
