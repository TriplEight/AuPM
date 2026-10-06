// proxy/src/build-info.ts
//
// Release identity of the running image. The image build passes AUPM_VERSION
// (a `v*` tag, or `pr-<number>` for a PR build) and AUPM_COMMIT (a 40-hex
// SHA). A run without them reports version "dev" and commit null. A
// malformed value falls back the same way, with one log line. It never
// stops the boot.

export type BuildInfo = { version: string; commit: string | null }

const VERSION_SHAPE = /^(v\d+\.\d+\.\d+[0-9A-Za-z.+-]*|pr-\d+|dev)$/
const COMMIT_SHAPE = /^[0-9a-f]{40}$/

export function resolveBuildInfo(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.warn,
): BuildInfo {
  let version = 'dev'
  let commit: string | null = null

  const rawVersion = env.AUPM_VERSION
  if (rawVersion) {
    if (VERSION_SHAPE.test(rawVersion)) {
      version = rawVersion
    } else {
      warn('[build-info] AUPM_VERSION has an invalid shape; reporting "dev"')
    }
  }

  const rawCommit = env.AUPM_COMMIT
  if (rawCommit) {
    if (COMMIT_SHAPE.test(rawCommit)) {
      commit = rawCommit
    } else {
      warn('[build-info] AUPM_COMMIT is not a 40-hex SHA; reporting null')
    }
  }

  return { version, commit }
}

export const buildInfo: BuildInfo = resolveBuildInfo(process.env)
