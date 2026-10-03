// proxy/src/discovery.ts
//
// Two free discovery documents: the x402 descriptor at `GET /.well-known/x402`
// and the agent guide at `GET /llms.txt`. The facilitator lists both in the
// merchant record `agent` field. Every value comes from the constants that
// the paid routes use (proxy/src/x402/routes.ts, proxy/src/config.ts).
// This file holds no second copy of a price, an address or a description.
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

/** Build the markdown body of `GET /llms.txt`. */
export function buildLlmsTxt(issuer: string = ISSUER): string {
  return `# ${MERCHANT_NAME}

> ${OG_DESCRIPTION}

## Payment terms

- Protocol: x402, scheme \`exact\`.
- Network: \`${CAIP2_NETWORK}\`.
- Asset: USDC, ASA ${USDC_ASA_ID}.
- Pay to: \`${PAY_TO}\`.
- Facilitator: ${FACILITATOR_URL}.
- Tag: \`${TAG}\`.
- Price: ${PRICE_TEXT} (${PRICE_MICRO_TEXT}) per reviewed package.
- ${SPLIT_DISCLOSURE}

## Routes

### GET /v1/attest?name=@babel/core&version=7.25.2

Query parameters: \`name\` and \`version\`. The scoped name contains \`/\`.
The response is a DSSE envelope with an in-toto Statement v1 attestation.
Price: ${PRICE_TEXT} when the version is reviewed. Free when it is not.

### POST /v1/attest/lockfile

Send a \`package-lock.json\` as the request body.
The response is one DSSE in-toto attestation for the whole lockfile.
Price: ${PRICE_TEXT} per reviewed entry. 0 reviewed entries: free.
There is no cap and no discount.

### Payment flow

1. Send the request without payment.
2. The server answers 402 with a \`PAYMENT-REQUIRED\` header.
3. Sign the payment and retry the same request with a \`PAYMENT-SIGNATURE\` header.
4. The facilitator verifies and settles the payment. The server returns the attestation.

## Free path

- Send \`X-AuPM-Donate: 0\` on an attestation route. The server returns a free partial
  attestation.
- Plain \`npm install\` through the registry stays free.
- An unreviewed package never returns 402.
- A reviewed tarball returns 402 only with \`X-AuPM-Donate: 1\`.

## Tools

- CLI \`aupm\`: \`aupm install <pkg> [--donate]\`, \`aupm attest <lockfile> [--donate]\`,
  and the offline check \`aupm verify <attestation.json>\`. Donation is opt-in.
- MCP server \`aupm\`: tools \`check_audit_status\`, \`install_audited_package\`
  and \`attest_lockfile\`.
- GitHub Action: \`.github/actions/aupm-attest/\` in the repository.

## Links

- Descriptor: ${issuer}/.well-known/x402
- Attestation keys: ${issuer}/.well-known/aupm-keys.json
- Repository: ${REPO_URL}
`
}
