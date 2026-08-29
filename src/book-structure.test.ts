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
