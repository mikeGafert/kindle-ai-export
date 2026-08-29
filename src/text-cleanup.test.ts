import { describe, expect, test } from 'vitest'

import { stripMarkdown } from './text-cleanup'

describe('stripMarkdown', () => {
  test('removes what the OCR added', () => {
    expect(stripMarkdown('# Kapitel eins')).toBe('Kapitel eins')
    expect(stripMarkdown('![img-0.jpeg](img-0.jpeg)\nText')).toBe('Text')
    expect(stripMarkdown('Tinte &amp; Feder')).toBe('Tinte & Feder')
    expect(stripMarkdown('|  |   |\n| --- | --- |')).toBe('')
    expect(stripMarkdown('#\nAbsatz')).toBe('Absatz')
    expect(stripMarkdown('---\nAbsatz')).toBe('Absatz')
  })

  test('pulls stray spaces onto the preceding word', () => {
    expect(stripMarkdown('»Nirgendwo «?')).toBe('»Nirgendwo«?')
    expect(stripMarkdown('Er ging .')).toBe('Er ging.')
  })

  test('keeps the space before an opening German quote', () => {
    // » opens in German — removing its leading space would glue words together.
    expect(stripMarkdown('nannte es »Utopia«')).toBe('nannte es »Utopia«')
  })

  test('leaves ordinary prose untouched', () => {
    const prose = [
      'Auf ihrem Sterbebett nimmt eine junge Frau ihrem Mann das Gelöbnis ab,',
      'sich nach ihrem Tode nie mit einer anderen einzulassen.',
      '',
      'Das Bewußtsein — vielleicht — der zwanzig Millionen.'
    ].join('\n')
    expect(stripMarkdown(prose)).toBe(prose)
  })

  test('does not eat legitimate hyphens, dashes or asterisks in prose', () => {
    expect(stripMarkdown('E-Mail-Adresse')).toBe('E-Mail-Adresse')
    expect(stripMarkdown('der Kaffee – schwarz – stand da')).toBe(
      'der Kaffee – schwarz – stand da'
    )
    // A lone asterisk as a scene break is markup, but 5*3 is content.
    expect(stripMarkdown('5*3 ergibt 15')).toBe('5*3 ergibt 15')
  })

  test('does not mistake a numbered line for a heading', () => {
    expect(stripMarkdown('1970 war ein gutes Jahr')).toBe(
      '1970 war ein gutes Jahr'
    )
  })

  test('survives empty and whitespace-only input', () => {
    expect(stripMarkdown('')).toBe('')
    expect(stripMarkdown('   \n\n  ')).toBe('')
  })
})
