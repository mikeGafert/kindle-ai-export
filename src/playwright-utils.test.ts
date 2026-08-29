import { describe, expect, test } from 'vitest'

import { parsePageNav } from './playwright-utils'

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
