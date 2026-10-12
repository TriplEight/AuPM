// cli/src/npm-prefix.ts
//
// Asks npm which folder it used as its prefix. npm writes `package-lock.json`
// there. AuPM asks npm because the rule covers workspaces, `--prefix` and `-C`.
import { spawn } from 'node:child_process'
import { proxyUrl } from 'aupm-mcp/proxy-url'

/**
 * Returns the flags from the user's npm args that change the npm prefix:
 * `--prefix <dir>`, `--prefix=<dir>` and `-C <dir>`. Tokens after a literal `--` are skipped.
 * `--workspace` does not change the prefix, so it is not passed.
 */
export function prefixLocationArgs(npmArgs: string[]): string[] {
  const end = npmArgs.indexOf('--')
  const own = end < 0 ? npmArgs : npmArgs.slice(0, end)
  const kept: string[] = []
  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index]
    if (arg.startsWith('--prefix=')) {
      kept.push(arg)
    } else if ((arg === '--prefix' || arg === '-C') && index + 1 < own.length) {
      kept.push(arg, own[index + 1])
      index += 1
    }
  }
  return kept
}

/**
 * Runs `npm prefix` in the current folder with the install's env. Returns the folder
 * that npm prints, or null if npm fails or prints nothing. Never throws.
 */
export function runNpmPrefix(npmArgs: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let output = ''
    try {
      const child = spawn('npm', ['prefix', ...prefixLocationArgs(npmArgs)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, npm_config_registry: proxyUrl() },
      })
      child.stdout?.on('data', (chunk: Buffer | string) => {
        output += chunk.toString()
      })
      child.on('error', () => resolve(null))
      child.on('close', (code) => {
        const folder = output.trim()
        resolve(code === 0 && folder !== '' ? folder : null)
      })
    } catch {
      resolve(null)
    }
  })
}
