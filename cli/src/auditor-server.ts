// cli/src/auditor-server.ts
//
// The AuPM server reads of the auditor commands. The app id and the payTo address come from
// GET /api/v1/contract only. They are never hardcoded.

export interface ContractInfo {
  network: string
  appId: number
  payTo: string
  usdcAssetId: number
  minClaim: number
}

export interface ReviewRecord {
  name: string
  version: string
  status: string
  scope: string
  anchorTxid: string
  reviewedAt: string
}

type Fetch = typeof fetch

const UNREADABLE_ANSWER =
  'The AuPM server sent an answer this CLI cannot read. Update the CLI: npm install -g aupm-cli.'

async function getJson(fetchImpl: Fetch, url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url)
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Cannot reach the AuPM server (${new URL(url).origin}): ${reason}. ` +
        'Check your network and try again.',
    )
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown }
    const reason = typeof body.error === 'string' ? ` (${body.error})` : ''
    throw new Error(`The AuPM server answered ${res.status}${reason}. Try again later.`)
  }
  return res.json()
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

/** Reads the contract facts. Throws when the server has no contract configured (503). */
export async function fetchContract(fetchImpl: Fetch, origin: string): Promise<ContractInfo> {
  const body = (await getJson(fetchImpl, `${origin}/api/v1/contract`)) as Partial<ContractInfo>
  const { network, appId, payTo, usdcAssetId, minClaim } = body
  if (
    typeof network !== 'string' ||
    typeof payTo !== 'string' ||
    !isPositiveInt(appId) ||
    !isPositiveInt(usdcAssetId) ||
    !isPositiveInt(minClaim)
  ) {
    throw new Error(UNREADABLE_ANSWER)
  }
  return { network, appId, payTo, usdcAssetId, minClaim }
}

/** Reads the reviews of one auditor. `login` is the lower-case bare login. */
export async function fetchReviews(
  fetchImpl: Fetch,
  origin: string,
  login: string,
): Promise<ReviewRecord[]> {
  const url = `${origin}/api/v1/reviews?reviewer=${encodeURIComponent(login)}`
  const body = (await getJson(fetchImpl, url)) as { reviews?: unknown }
  if (!Array.isArray(body.reviews)) {
    throw new Error(UNREADABLE_ANSWER)
  }
  return body.reviews as ReviewRecord[]
}

/** The version of the latest review of `name` other than `version`, or null. */
export function previousReviewedVersion(
  reviews: ReviewRecord[],
  name: string,
  version: string,
): string | null {
  const others = reviews.filter((r) => r.name === name && r.version !== version)
  others.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))
  return others[0]?.version ?? null
}

/** The dist.integrity npm published for name@version. */
export async function fetchNpmIntegrity(
  fetchImpl: Fetch,
  name: string,
  version: string,
): Promise<string> {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`
  const res = await fetchImpl(url)
  if (res.status === 404) throw new Error(`npm has no package "${name}". Check the spelling.`)
  if (!res.ok) throw new Error(`npm registry returned ${res.status} for ${name}.`)
  const packument = (await res.json()) as {
    versions?: Record<string, { dist?: { integrity?: unknown } }>
  }
  const doc = packument.versions?.[version]
  if (!doc) throw new Error(`npm has no published version ${name}@${version}.`)
  const integrity = doc.dist?.integrity
  if (typeof integrity !== 'string' || integrity.length === 0) {
    throw new Error(`npm dist.integrity is missing for ${name}@${version}.`)
  }
  return integrity
}
