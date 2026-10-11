// cli/src/auditor-terminal.ts
//
// Terminal input of the auditor commands: the hidden key prompt, the visible questions, the
// mnemonic check and the login helper. WARNING: never print, log or store the words.
import readline from 'node:readline/promises'
import algosdk from 'algosdk'
import { proxyUrl } from 'aupm-mcp/proxy-url'
import type { NetworkName } from './auditor-chain.js'

export interface AuditorDeps {
  isTTY: boolean
  ask: (question: string) => Promise<string>
  askSecret: (question: string) => Promise<string>
  print: (line: string) => void
  fetch: typeof fetch
  algod: (network: NetworkName) => algosdk.Algodv2
  origin: string
}

/** The one place that lower-cases a GitHub login. */
export function normalizeLogin(raw: string): string {
  const login = raw.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)) {
    throw new Error(`"${raw.trim()}" is not a GitHub login.`)
  }
  return login
}

/** Reads one line from stdin with no echo. */
export function readHiddenLine(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    let line = ''
    process.stdout.write(question)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const finish = (done: () => void) => {
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
      done()
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(line))
        if (ch === '\u0003') return finish(() => reject(new Error('Stopped.')))
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1)
        else line += ch
      }
    }
    input.on('data', onData)
  })
}

async function askVisible(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

function defaultAlgod(network: NetworkName): algosdk.Algodv2 {
  const override =
    network === 'testnet' ? process.env.ALGOD_TESTNET_URL : process.env.ALGOD_MAINNET_URL
  const url = override || `https://${network}-api.algonode.cloud`
  return new algosdk.Algodv2('', url, '')
}

export function defaultDeps(): AuditorDeps {
  return {
    isTTY: process.stdin.isTTY === true,
    ask: askVisible,
    askSecret: readHiddenLine,
    print: (line) => console.log(line),
    fetch: globalThis.fetch,
    algod: defaultAlgod,
    origin: proxyUrl(),
  }
}

export type AuditorAccount = { addr: { toString(): string }; sk: Uint8Array }

/** Turns the typed words into an account. Only the 25-word Algo25 phrase works for now. */
export function accountFromWords(words: string): AuditorAccount {
  const count = words.trim().split(/\s+/).filter(Boolean).length
  if (count === 24) {
    throw new Error('A 24-word phrase is not supported yet. Support comes later.')
  }
  if (count !== 25) {
    throw new Error(`The key must be a 25-word Algorand mnemonic. You typed ${count} words.`)
  }
  try {
    return algosdk.mnemonicToSecretKey(words.trim())
  } catch {
    throw new Error('The 25 words are not a valid Algorand mnemonic. Check each word.')
  }
}

/** Asks for the key on a hidden prompt. The caller wipes `sk` after use. */
export async function promptAccount(deps: AuditorDeps): Promise<AuditorAccount> {
  return accountFromWords(await deps.askSecret('Auditor key (25 words, not shown): '))
}
