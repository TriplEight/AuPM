import algosdk from 'algosdk'
import fs from 'node:fs'
import path from 'node:path'

const roles = ['PAYER', 'AUDITOR', 'MAINTAINER', 'ADVERSARIAL', 'TREASURY', 'OPS'] as const

const accounts = Object.fromEntries(
  roles.map((role) => [role, algosdk.generateAccount()]),
) as Record<(typeof roles)[number], algosdk.Account>

const lines = Object.entries(accounts).flatMap(([name, acct]) => [
  `${name}_ADDR=${acct.addr}`,
  `${name}_MNEMONIC="${algosdk.secretKeyToMnemonic(acct.sk)}"`,
])

const envPath = path.resolve(process.cwd(), '.env')
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') + '\n' : ''
fs.writeFileSync(envPath, existing + lines.join('\n') + '\n')

console.log('Generated accounts (fund these on TestNet):')
for (const [name, acct] of Object.entries(accounts)) {
  console.log(`  ${name}: ${acct.addr}`)
}
console.log('\nFund ALGO via: https://bank.testnet.algorand.network/')
console.log('Fund USDC (ASA 10458941) via: https://faucet.circle.com/')
console.log('\nAppended mnemonics to .env — keep secret, never commit!')
