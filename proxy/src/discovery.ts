// proxy/src/discovery.ts
//
// Two free discovery documents: the x402 descriptor at `GET /.well-known/x402`
// and the agent guide at `GET /llms.txt`. The facilitator lists both in the
// merchant record `agent` field. Every value comes from the constants that
// the paid routes use (proxy/src/x402/routes.ts, proxy/src/config.ts).
// This file holds no second copy of a price, an address or a description.

import { LOCKFILE_MAX_BYTES, LOCKFILE_MAX_ENTRIES } from './attest/lockfile.js'
import { CAIP2_NETWORK, FACILITATOR_URL, ISSUER, PAY_TO, TAG, USDC_ASA_ID } from './config.js'
import { PRICE_PER_REVIEWED_PACKAGE_MICRO } from './routes/attest.js'
import {
  LOCKFILE_DESCRIPTION,
  LOCKFILE_ROUTE_KEY,
  MERCHANT_CATEGORIES,
  MERCHANT_LOGO_PATH,
  MERCHANT_NAME,
  OG_DESCRIPTION,
  PRICE_TEXT,
  SINGLE_ATTEST_DESCRIPTION,
  SINGLE_ATTEST_ROUTE_KEY,
  SPLIT_DISCLOSURE,
} from './x402/routes.js'

const REPO_URL = 'https://github.com/TriplEight/AuPM'

export interface DiscoveryResource {
  url: string
  method: string
  description: string
  network: string
  asset: string
  amount: string
  payTo: string
  tags: string[]
}

export interface X402Descriptor {
  x402Version: 2
  name: string
  description: string
  website: string
  logo: string
  tags: string[]
  categories: string[]
  resources: DiscoveryResource[]
}

// "1000" becomes "1,000". Integer micro-units only.
function groupDigits(micro: number): string {
  return String(micro).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const PRICE_MICRO_TEXT = `${groupDigits(PRICE_PER_REVIEWED_PACKAGE_MICRO)} µUSDC`

const LOCKFILE_DISCOVERY_DESCRIPTION =
  `${LOCKFILE_DESCRIPTION} Price: ${PRICE_MICRO_TEXT} per reviewed entry. ` +
  '0 reviewed entries: free.'

// The tarball route is not listed: its route key is a wildcard pattern, not
// a URL, and it charges only with `X-AuPM-Donate: 1`.
function paidResources(issuer: string): DiscoveryResource[] {
  const common = {
    network: CAIP2_NETWORK,
    asset: USDC_ASA_ID,
    amount: String(PRICE_PER_REVIEWED_PACKAGE_MICRO),
    payTo: PAY_TO,
    tags: [TAG],
  }
  const [lockfileMethod, lockfilePath] = LOCKFILE_ROUTE_KEY.split(' ')
  const [singleMethod, singlePath] = SINGLE_ATTEST_ROUTE_KEY.split(' ')
  return [
    {
      url: `${issuer}${lockfilePath}`,
      method: lockfileMethod as string,
      description: LOCKFILE_DISCOVERY_DESCRIPTION,
      ...common,
    },
    {
      url: `${issuer}${singlePath}`,
      method: singleMethod as string,
      description: SINGLE_ATTEST_DESCRIPTION,
      ...common,
    },
  ]
}

/** Build the JSON body of `GET /.well-known/x402`. */
export function buildX402Descriptor(issuer: string = ISSUER): X402Descriptor {
  return {
    x402Version: 2,
    name: MERCHANT_NAME,
    description: OG_DESCRIPTION,
    website: issuer,
    logo: `${issuer}${MERCHANT_LOGO_PATH}`,
    tags: ['npm', 'security', TAG],
    categories: MERCHANT_CATEGORIES,
    resources: paidResources(issuer),
  }
}

const BYTES_PER_MIB = 1024 * 1024
const LOCKFILE_LIMITS_TEXT =
  `lockfileVersion 2 or 3, body at most ${LOCKFILE_MAX_BYTES / BYTES_PER_MIB} MiB, ` +
  `at most ${groupDigits(LOCKFILE_MAX_ENTRIES)} entries`

const SUMMARY_SECTION = `# ${MERCHANT_NAME}

> An npm registry overlay that tells you which package versions a human auditor has read, with
> signed, verifiable attestations. Optional USDC donations fund those audits.

AuPM is at an early stage. Few packages are reviewed today, and the project seeks adoption.
"Unreviewed" is the normal answer. It is not an error.
No payment ever happens without explicit opt-in. Plain \`npm install\` stays free.`

const WHEN_AND_TRUST_SECTION = `## When to use AuPM

- Before you add a dependency.
- Before you merge a lockfile change.
- In CI, on every pull request.

A \`COMMUNITY_REVIEWED\` version means a human read that exact tarball and anchored the review
on Algorand. That is safer than an unreviewed version.
The user benefits twice. Dependencies get safer. Donations pay auditors to read the open-source
code that the user already runs.

## Why you can trust it

- \`aupm\` runs the real npm.
- The registry passes npm traffic through unchanged. The integrity hashes are npm's own.
- AuPM adds only the review layer that npm lacks, for supply-chain security.
- The donor key signs on the user's machine. The AuPM server never holds it.
- Payment goes through the GoPlausible facilitator (${FACILITATOR_URL}).`

const AGENT_SECTION = `## For a developer's coding agent

Follow these steps.

1. Check the status first. It is free and needs no wallet:

   - \`GET /api/v1/status/<pkg>/<version>\`
   - \`GET /api/v1/status/<@scope>/<pkg>/<version>\`

2. Read the JSON. This is the shape. An unreviewed version has \`null\` in the review fields:

   \`\`\`json
   {
     "pkg": "<pkg>", "version": "<version>", "status": "UNREVIEWED",
     "auditor_addr": null, "anchor_txid": null, "integrity": null,
     "reviewer": null, "review_scope": null, "repo": null, "ts": null
   }
   \`\`\`

3. Call a paid route only after the status call. Call it only if the user opted in to donate.
   Without opt-in, send \`X-AuPM-Donate: 0\` and get a free partial attestation.
4. Install as usual. \`npm install\` through this registry never asks for payment.

Never sign a payment without the user's explicit opt-in.`

const READING_SECTION = `## How to read results

- Tiers: \`UNREVIEWED\`, \`COMMUNITY_REVIEWED\`.
- Warnings: \`INTEGRITY_MISMATCH\` and \`UNRESOLVABLE\`. AuPM always lists them and never charges
  for them.
- A package that is absent from \`predicate.packages\` means \`predicate.absentMeans\`. The value
  is \`UNREVIEWED\`. In a partial attestation it is \`UNREVIEWED_OR_WITHHELD\`.
- \`predicate.withheld\` counts the reviewed entries that a free partial attestation leaves out.
  A full attestation has \`predicate.withheld: 0\`.`

function routesSection(issuer: string): string {
  return `## Paid routes

Both routes answer \`{ summary, attestation }\`. \`summary\` is an unsigned copy.
Verify \`attestation\`.

### GET /v1/attest?name=@babel/core&version=7.25.2

Price: ${PRICE_TEXT} when the version is reviewed. Free when it is not.

\`\`\`bash
curl -sS "${issuer}/v1/attest?name=@babel/core&version=7.25.2"
\`\`\`

### POST /v1/attest/lockfile

Body: the \`package-lock.json\` bytes, unchanged.
Limits: ${LOCKFILE_LIMITS_TEXT}.
Price: ${PRICE_TEXT} (${PRICE_MICRO_TEXT}) per reviewed entry. 0 reviewed entries: free.
There is no cap and no discount.

\`\`\`bash
curl -sS -X POST "${issuer}/v1/attest/lockfile" \\
  -H 'content-type: application/json' --data-binary @package-lock.json
\`\`\`

### Payment flow

1. Send the request without payment.
2. The server answers 402 with a \`PAYMENT-REQUIRED\` header.
3. Check the quoted amount.
4. Retry the same request with a \`PAYMENT-SIGNATURE\` header.
5. The facilitator verifies and settles the payment. The server returns the attestation.`
}

const OPTIONS_SECTION = `## Options

### HTTP

| Name | Meaning |
|---|---|
| \`X-AuPM-Donate: 1\` | On a reviewed tarball: pay for it. Without it, the tarball is free. |
| \`X-AuPM-Donate: 0\` | On an attestation route: return a free partial attestation. |
| \`X-AuPM-Tier\` | Response header on a tarball. It holds the status of the version. |

An unreviewed package never returns 402.

### CLI \`aupm\`

| Name | Meaning |
|---|---|
| \`--donate\` | Pay for reviewed content. Off by default. |
| \`--attest-out <path>\` | \`aupm install\`: write the attestation to this path. |
| \`--out <path>\` | \`aupm attest\`: write the attestation to this path. |
| \`--lockfile <path>\` | \`aupm verify\`: also check the lockfile digest. |
| \`--key <keyid>:<base64pubkey>\` | \`aupm verify\`: trust this key. Repeatable. |
| \`--keys <aupm-keys.json>\` | \`aupm verify\`: trust the keys in this file. |
| \`AUPM_PROXY_URL\` | Registry origin. It defaults to the MainNet deployment. |
| \`AUPM_DONOR_MNEMONIC\` | The donor key. Read only with \`--donate\`. |
| \`NETWORK\` | \`testnet\` selects the TestNet rehearsal. MainNet is the default. |

Commands: \`aupm install <pkg>\`, \`aupm attest <lockfile>\`, \`aupm verify <attestation.json>\`.
Any other first argument goes to npm unchanged.

### MCP server \`aupm\`

| Tool | Parameters |
|---|---|
| \`check_audit_status\` | \`pkg\`, \`version\`. Free. |
| \`install_audited_package\` | \`pkg\`, \`version\`, \`allowDonation\` (default off). |
| \`attest_lockfile\` | \`lockfilePath\`, \`allowDonation\` (default off). |

### GitHub Action \`aupm\`

| Input | Meaning |
|---|---|
| \`endpoint\` | URL of the AuPM server. Required. |
| \`lockfile\` | Path to the lockfile. Default \`package-lock.json\`. |
| \`fail-on-mismatch\` | \`true\` fails the step when \`integrityMismatch\` is above zero. |
| \`install\` | \`npm\` runs \`npm ci\` through AuPM, with fallback to npm. \`none\` skips it. Default \`npm\`. |
| \`output\` | Path of the signed receipt file. Default \`aupm-receipt.json\`. |
| \`donate\` | \`true\` donates to the reviewed packages. Default \`false\`. |
| \`donor-secret\` | A funded donor mnemonic (25 words) from a GitHub secret. Read only with \`donate\`. |

An install failure fails the job, as with plain npm. An AuPM failure never fails the job, unless \`fail-on-mismatch\` is \`true\`.`

function setupSection(issuer: string): string {
  return `## Setup

Use AuPM as the npm registry. This never donates.

\`\`\`bash
npm config set registry ${issuer}/
\`\`\`

Add the Action to a workflow:

\`\`\`yaml
- uses: TriplEight/AuPM/.github/actions/aupm@<ref>
  with:
    endpoint: ${issuer}
    lockfile: package-lock.json
\`\`\`

The CLI and the MCP server run from a clone of the repository until the first npm release.
See "after the first npm release" in the README.

### How the user opts in to donate

1. The user holds USDC (ASA ${USDC_ASA_ID}) in an Algorand account.
   The facilitator pays the network fee.
2. The user sets \`AUPM_DONOR_MNEMONIC\` on their own machine, or as a CI secret.
3. The user adds \`--donate\` to one command, for example \`aupm attest package-lock.json --donate\`.
   In MCP, the user sets \`allowDonation\`. In the Action, the user sets \`donate: 'true'\`.

Each paid call pays for the review of code that the user installs.`
}

function verifySection(issuer: string): string {
  return `## Verify an attestation

- The attestation is a DSSE envelope with an in-toto Statement v1, signed with ed25519.
- Public keys: ${issuer}/.well-known/aupm-keys.json
- \`aupm verify <attestation.json>\` checks it offline.
- The review anchor is an Algorand transaction. Its sender is the auditor.`
}

const VISITORS_SECTION = `## For CI

Run the Action on every pull request. It writes the signed attestation to \`output\`.
Upload that file with \`actions/upload-artifact\`. Set \`donate: 'true'\` only to pay.

## For an auditor's agent

Onboarding is manual. Open an issue in ${REPO_URL}. The steps:

1. Open an Algorand account and opt it in to USDC.
2. The admin maps your identity on-chain.
3. Read the exact tarball you review.
4. Anchor the review with a 0-ALGO self-payment to your own address. The note is \`aupm:j{...}\`.
5. The operator records the review. The package becomes \`COMMUNITY_REVIEWED\`.
6. The nightly batch credits your balance. Call \`claim()\` when it reaches the minimum.

Check earnings for free: \`GET /api/v1/earnings/github/:login\`.

## For a verifier or security tool

Fetch the keys. Run \`aupm verify\`. Look up the anchor transaction on Algorand.
Check that its sender is the auditor.

## For crawlers and indexers

The x402 descriptor is \`/.well-known/x402\`. The routes are listed in the Bazaar.
All content on this site is free to index.`

const DONATION_SECTION = `## Where a donation goes

${SPLIT_DISCLOSURE}

### Payment terms

- Protocol: x402, scheme \`exact\`.
- Network: \`${CAIP2_NETWORK}\`.
- Asset: USDC, ASA ${USDC_ASA_ID}.
- Pay to: \`${PAY_TO}\`.
- Facilitator: ${FACILITATOR_URL}.
- Tag: \`${TAG}\`.
- Price: ${PRICE_TEXT} (${PRICE_MICRO_TEXT}) per reviewed package.`

function linksSection(issuer: string): string {
  return `## Links

- Descriptor: ${issuer}/.well-known/x402
- Attestation keys: ${issuer}/.well-known/aupm-keys.json
- Status example: ${issuer}/api/v1/status/ms/2.1.3
- Repository: ${REPO_URL}`
}

/** Build the markdown body of `GET /llms.txt`. */
export function buildLlmsTxt(issuer: string = ISSUER): string {
  const sections = [
    SUMMARY_SECTION,
    WHEN_AND_TRUST_SECTION,
    AGENT_SECTION,
    READING_SECTION,
    routesSection(issuer),
    OPTIONS_SECTION,
    setupSection(issuer),
    verifySection(issuer),
    VISITORS_SECTION,
    DONATION_SECTION,
    linksSection(issuer),
  ]
  return `${sections.join('\n\n')}\n`
}
