import { describe, expect, test } from 'vitest'

import { normalizeAuthors, parseAsins } from './utils'

describe('parseAsins', () => {
  test('accepts the documented input shapes', () => {
    expect(parseAsins('B07QLY87NH')).toEqual(['B07QLY87NH'])
    expect(parseAsins('B07QLY87NH,B00957T6X6')).toEqual([
      'B07QLY87NH',
      'B00957T6X6'
    ])
    expect(parseAsins(' B000000001 , B000000002 ;B000000003 ')).toEqual([
      'B000000001',
      'B000000002',
      'B000000003'
    ])
    expect(parseAsins('["B07QLY87NH","B00957T6X6"]')).toEqual([
      'B07QLY87NH',
      'B00957T6X6'
    ])
  })

  test('deduplicates while keeping order', () => {
    expect(parseAsins('B000000002,B000000001,B000000002')).toEqual([
      'B000000002',
      'B000000001'
    ])
  })

  test('treats empty input as no books rather than one empty book', () => {
    // An empty ASIN reaching path.join() would point at the whole work
    // directory — which finalize-book deletes.
    expect(parseAsins('')).toEqual([])
    expect(parseAsins('   ')).toEqual([])
    expect(parseAsins(undefined)).toEqual([])
    expect(parseAsins(',,;  ;')).toEqual([])
  })

  test('rejects a malformed JSON array instead of silently ignoring it', () => {
    expect(() => parseAsins('["B07QLY87NH",')).toThrow()
  })
})

describe('normalizeAuthors', () => {
  test('turns "Last, First" into "First Last"', () => {
    expect(normalizeAuthors(['Grimm, Gebrüder'])).toEqual(['Gebrüder Grimm'])
  })

  test('splits the colon-joined form Amazon used to send', () => {
    expect(normalizeAuthors(['Doe, Jane:Roe, John'])).toEqual([
      'Jane Doe',
      'John Roe'
    ])
  })

  test('survives empty input', () => {
    expect(normalizeAuthors([])).toEqual([])
  })
})

describe('parseAsins — path safety', () => {
  // An ASIN becomes a directory name that finalize-book later deletes.
  // These are the inputs that would make it point somewhere dangerous.
  test.each(['.', '..', '../..', 'foo/../..', '/etc', 'a/b', 'B07QLY87N'])(
    'rejects %j instead of turning it into a path',
    (bad) => {
      expect(() => parseAsins(bad)).toThrow(/not a valid ASIN/)
    }
  )

  test('still accepts real ASINs in any case', () => {
    expect(parseAsins('b07qly87nh')).toEqual(['b07qly87nh'])
    expect(parseAsins('1234567890')).toEqual(['1234567890'])
  })
})
