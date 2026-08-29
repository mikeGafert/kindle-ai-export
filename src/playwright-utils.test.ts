import { describe, expect, test } from 'vitest'

import { parsePageNav, parseTocItems } from './playwright-utils'

describe('parsePageNav', () => {
  test('reads the English footer', () => {
    expect(parsePageNav('Page 3 of 250')).toEqual({ page: 3, total: 250 })
    expect(parsePageNav('Location 42 of 1765')).toEqual({
      location: 42,
      total: 1765
    })
  })

  test('reads the German footer', () => {
    // This is what the reader actually shows in a German account — missing it
    // made every book stop after zero pages.
    expect(parsePageNav('Seite 3 von 250')).toEqual({ page: 3, total: 250 })
    expect(parsePageNav('Position 1 von 1765 ● 0%')).toEqual({
      location: 1,
      total: 1765
    })
  })

  test('handles roman numerals in front matter', () => {
    expect(parsePageNav('Page xiv of 250')).toEqual({
      location: 14,
      total: 250
    })
  })

  test('returns undefined for anything else', () => {
    expect(parsePageNav('')).toBeUndefined()
    expect(parsePageNav(null)).toBeUndefined()
    expect(parsePageNav('Lesegeschwindigkeit lernen ...')).toBeUndefined()
  })
})

const toc = (labels: string[]) =>
  labels.map((label, i) => ({
    label,
    positionId: i * 100,
    page: i + 1,
    depth: 0
  })) as any

describe('parseTocItems — back matter detection', () => {
  test('cuts German back matter off the main content', () => {
    // Ten entries so the 90 % threshold puts the last ones in range.
    const items = toc([
      'Kapitel 1',
      'Kapitel 2',
      'Kapitel 3',
      'Kapitel 4',
      'Kapitel 5',
      'Kapitel 6',
      'Kapitel 7',
      'Kapitel 8',
      'Kapitel 9',
      'Danksagung'
    ])
    const parsed = parseTocItems(items, { totalNumPages: 10 })
    expect(parsed.firstPostContentPageTocItem?.label).toBe('Danksagung')
  })

  test('keeps an epilogue as content, in German as well', () => {
    const items = toc([
      'Kapitel 1',
      'Kapitel 2',
      'Kapitel 3',
      'Kapitel 4',
      'Kapitel 5',
      'Kapitel 6',
      'Kapitel 7',
      'Kapitel 8',
      'Kapitel 9',
      'Epilog'
    ])
    const parsed = parseTocItems(items, { totalNumPages: 10 })
    expect(parsed.firstPostContentPageTocItem).toBeUndefined()
  })

  test('still recognises the English labels', () => {
    const items = toc([
      'Chapter 1',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
      'Chapter 5',
      'Chapter 6',
      'Chapter 7',
      'Chapter 8',
      'Chapter 9',
      'About the Author'
    ])
    const parsed = parseTocItems(items, { totalNumPages: 10 })
    expect(parsed.firstPostContentPageTocItem?.label).toBe('About the Author')
  })
})
