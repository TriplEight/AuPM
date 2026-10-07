export class YarnParseError extends Error {}

export interface YarnClassicEntry {
  name: string
  version: string
  integrity: string | null
  resolved: string | null
}

export function parseYarnClassic(text: string): YarnClassicEntry[]
