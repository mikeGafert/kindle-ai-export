import { describe, expect, test } from 'vitest'

import type { BookMetadata, ContentChunk, TocItem } from './types'
import { getChapters } from './book-structure'

function chunk(page: number, text: string): ContentChunk {
  return { index: page, page, text, screenshot: `p${page}.png` }
}

function meta(toc: Partial<TocItem>[], nav: Partial<BookMetadata['nav']> = {}) {
  return {
    meta: { title: 'Testbuch', authorList: ['A. Utor'] },
    nav: { startPosition: 0, endPosition: 1000, ...nav },
    toc: toc.map((item, i) => ({
      label: `Kapitel ${i + 1}`,
      positionId: 0,
      depth: 0,
      ...item
    }))
  } as unknown as BookMetadata
}

/** Every word of every page must appear somewhere in the chapters. */
function assertNoTextLost(
  content: ContentChunk[],
  chapters: { text: string }[]
) {
  const all = chapters.map((c) => c.text).join('\n')
  for (const c of content) {
    if (!c.text.trim()) continue
    expect(all, `page ${c.page} is missing from the export`).toContain(c.text)
  }
}

describe('getChapters — books with page numbers', () => {
  const content = [
    chunk(1, 'Titelei'),
    chunk(2, 'Vorwort-Text'),
    chunk(5, 'Anfang von eins'),
    chunk(6, 'Fortsetzung eins'),
    chunk(9, 'Anfang von zwei'),
    chunk(12, 'Schluss')
  ]

  test('splits at the TOC pages and loses nothing', () => {
    const chapters = getChapters(meta([{ page: 5 }, { page: 9 }]), content)
    expect(chapters.map((c) => c.label)).toEqual([
      'Beginn',
      'Kapitel 1',
      'Kapitel 2'
    ])
    assertNoTextLost(content, chapters)
  })

  test('keeps the front matter before the first chapter', () => {
    const chapters = getChapters(meta([{ page: 5 }, { page: 9 }]), content)
    expect(chapters[0]!.text).toContain('Titelei')
    expect(chapters[0]!.text).toContain('Vorwort-Text')
  })

  test('drops the chapter heading repeated in the page text', () => {
    // The reader prints the heading on the page and again as a running head,
    // and the export renders it separately — so it must not appear three times.
    const withHeading = [
      chunk(5, 'Kapitel 1\nKapitel 1\nEigentlicher Text'),
      chunk(9, 'Kapitel 2\nWeiterer Text')
    ]
    const chapters = getChapters(meta([{ page: 5 }, { page: 9 }]), withHeading)
    expect(chapters.find((c) => c.label === 'Kapitel 1')!.text).toBe(
      'Eigentlicher Text'
    )
  })

  test('drops the repeated title in the single-chapter fallback too', () => {
    const chapters = getChapters(meta([]), [
      chunk(1, 'Testbuch\nDer eigentliche Inhalt')
    ])
    expect(chapters[0]!.text).toBe('Der eigentliche Inhalt')
  })
})

describe('getChapters — books without page numbers', () => {
  // Every TOC entry says page 1; the real anchors are positionIds on a
  // different scale than the chunks' footer positions.
  const content = [
    chunk(100, 'Erster Abschnitt'),
    chunk(400, 'Mitte'),
    chunk(800, 'Letzter Abschnitt')
  ]
  const metadata = meta(
    [
      { page: 1, positionId: 0 },
      { page: 1, positionId: 500 }
    ],
    { startPosition: 0, endPosition: 1000 }
  )

  test('maps positionIds onto the chunk scale and loses nothing', () => {
    const chapters = getChapters(metadata, content)
    expect(chapters.length).toBeGreaterThan(1)
    assertNoTextLost(content, chapters)
  })
})

describe('getChapters — awkward tables of contents', () => {
  const content = [
    chunk(1, 'Vorspann'),
    chunk(5, 'Text von Teil eins'),
    chunk(9, 'Text von Kapitel zwei'),
    chunk(12, 'Schluss')
  ]

  test('merges a part title and chapter that share a page', () => {
    // Very common in print: "Teil Eins" and "Kapitel 1" open the same page.
    // Previously the first became an empty chapter and its heading vanished.
    const chapters = getChapters(
      meta([{ page: 5 }, { page: 5 }, { page: 9 }]),
      content
    )
    const labels = chapters.map((c) => c.label)
    expect(labels.some((l) => l.includes('Kapitel 1'))).toBe(true)
    expect(labels.some((l) => l.includes('Kapitel 2'))).toBe(true)
    assertNoTextLost(content, chapters)
  })

  test('drops a backwards anchor instead of duplicating a page', () => {
    // Anchors [10, 8, 9]: comparing against the raw array kept 10 and 9 and
    // put one page into two chapters.
    const chapters = getChapters(
      meta([{ page: 10 }, { page: 8 }, { page: 9 }]),
      content
    )
    const joined = chapters.map((c) => c.text).join('\n')
    for (const c of content) {
      const occurrences = joined.split(c.text).length - 1
      expect(occurrences, `"${c.text}" appears ${occurrences}x`).toBeLessThan(2)
    }
  })

  test('keeps prose that legitimately opens with its own title', () => {
    // A one-word chapter opening is a real stylistic device; only the page
    // heading and the running head may be stripped, not the prose.
    const chapters = getChapters(meta([{ page: 5 }, { page: 9 }]), [
      chunk(5, 'Verrat\nVerrat\nVerrat\nEr hatte es nie kommen sehen.'),
      chunk(9, 'Weiter')
    ])
    const first = chapters.find((c) => c.label === 'Kapitel 1')!
    expect(first.text).toContain('Verrat')
    expect(first.text).toContain('Er hatte es nie kommen sehen.')
  })
})

describe('getChapters — degenerate input', () => {
  const content = [chunk(1, 'Alles in einem'), chunk(2, 'Zweite Seite')]

  test('falls back to a single chapter when the TOC is unusable', () => {
    const chapters = getChapters(meta([{ page: 1 }]), content)
    expect(chapters).toHaveLength(1)
    assertNoTextLost(content, chapters)
  })

  test('survives an empty TOC', () => {
    const chapters = getChapters(meta([]), content)
    expect(chapters).toHaveLength(1)
    assertNoTextLost(content, chapters)
  })

  test('survives an unsorted TOC without losing text', () => {
    const chapters = getChapters(meta([{ page: 2 }, { page: 1 }]), content)
    assertNoTextLost(content, chapters)
  })

  test('never returns an empty chapter list for non-empty content', () => {
    expect(getChapters(meta([]), content).length).toBeGreaterThan(0)
    expect(getChapters(meta([{ page: 99 }]), content).length).toBeGreaterThan(0)
  })

  test('handles empty content without throwing', () => {
    expect(() => getChapters(meta([{ page: 1 }]), [])).not.toThrow()
  })
})
