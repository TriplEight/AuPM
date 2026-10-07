import { describe, expect, test } from 'vitest'
import { parseYarnClassic, YarnParseError } from './yarn-classic-parse.mjs'

const HEADER = '# yarn lockfile v1\n\n'

function failureOf(text: string): string {
  try {
    parseYarnClassic(text)
  } catch (error) {
    if (error instanceof YarnParseError) return error.message
    throw error
  }
  throw new Error('expected a YarnParseError')
}

describe('parseYarnClassic', () => {
  test('grouped selectors are one entry and a scoped name keeps its @', () => {
    const text = `${HEADER}"@babel/core@^7.0.0", "@babel/core@^7.25.2":\n  version "7.25.2"\n  resolved "https://r/x.tgz"\n  integrity sha512-x\n`
    expect(parseYarnClassic(text)).toEqual([
      {
        name: '@babel/core',
        version: '7.25.2',
        integrity: 'sha512-x',
        resolved: 'https://r/x.tgz',
      },
    ])
  })

  test('a missing integrity is null and dependency lines are skipped', () => {
    const text = `${HEADER}ms@2.1.3:\n  version "2.1.3"\n  dependencies:\n    a "^1"\n    "@s/b" "^2"\n`
    expect(parseYarnClassic(text)).toEqual([
      { name: 'ms', version: '2.1.3', integrity: null, resolved: null },
    ])
  })

  test('CRLF line endings parse the same as LF', () => {
    const lf = `${HEADER}ms@2.1.3:\n  version "2.1.3"\n  integrity sha512-ms\n`
    expect(parseYarnClassic(lf.replace(/\n/g, '\r\n'))).toEqual(parseYarnClassic(lf))
  })

  test('an unquoted version is accepted', () => {
    expect(parseYarnClassic('a@1:\n  version 1.0.0\n')[0]?.version).toBe('1.0.0')
  })

  test.each([
    ['an unterminated quote', 'a@1, "b@1:\n  version "1"\n', 'line 1', 'unterminated quote'],
    ['a field outside a block', '# yarn lockfile v1\n  version "1"\n', 'line 2', 'outside a block'],
    ['a block with no version', 'a@1:\n  integrity sha512-x\n', 'line 1', 'no "version"'],
    ['a duplicate header', 'a@1:\n  version "1"\n\na@1:\n  version "1"\n', 'line 4', 'duplicate'],
    ['selectors of two packages', 'a@1, b@1:\n  version "1"\n', 'line 1', 'different packages'],
    ['a selector without a version', 'a:\n  version "1"\n', 'line 1', 'no version part'],
    ['a line that is not a header', 'a@1\n', 'line 1', 'colon'],
    ['text after a quoted selector', '"a@1" x:\n  version "1"\n', 'line 1', 'after a quoted'],
    ['a duplicate version field', 'a@1:\n  version "1"\n  version "2"\n', 'line 3', 'duplicate'],
    ['a tab indent', 'a@1:\n\tversion "1"\n', 'line 2', 'tab'],
    ['a field with no value', 'a@1:\n  version\n', 'line 2', 'value'],
  ])('%s is an error that names the line', (_label, text, line, fragment) => {
    const message = failureOf(text)
    expect(message).toContain(line)
    expect(message).toContain(fragment)
  })

  test('an empty lockfile body has no entries', () => {
    expect(parseYarnClassic(HEADER)).toEqual([])
  })
})
