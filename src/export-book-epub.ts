import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import epubModule from 'epub-gen-memory'

import type { BookMetadata, ContentChunk } from './types'
import { getChapters } from './book-structure'
import { bookWorkDir } from './paths'
import { assert, getEnv, parseAsins, readJsonFile } from './utils'

// The package is CommonJS: the callable lives on `.default` when it is required
// from an ES module, and the shape differs between bundlers.
const epub =
  (epubModule as unknown as { default?: typeof epubModule }).default ??
  epubModule

/** Escapes text for XHTML and turns blank lines into paragraphs. */
function toXhtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p>${paragraph
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('\n', '<br/>')}</p>`
    )
    .join('\n')
}

export async function exportEpub(asin: string): Promise<string> {
  const outDir = bookWorkDir(asin)
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )

  assert(content.length, `${asin}: no transcribed content`)
  assert(metadata.meta, `${asin}: invalid metadata`)

  const chapters = getChapters(metadata, content)
  assert(chapters.length, `${asin}: could not split the book into chapters`)

  const buffer = await epub(
    {
      title: metadata.meta.title,
      author: metadata.meta.authorList,
      lang: metadata.meta.language ?? 'de',
      description: `Exported from Kindle (ASIN ${asin})`,
      tocTitle: 'Inhaltsverzeichnis',
      ignoreFailedDownloads: true
    },
    chapters.map((chapter) => ({
      title: chapter.label,
      content: toXhtml(chapter.text)
    }))
  )

  const epubPath = path.join(outDir, 'book.epub')
  await fs.writeFile(epubPath, buffer)
  return epubPath
}

// Allow running this file on its own.
if (path.basename(process.argv[1] ?? '').startsWith('export-book-epub')) {
  const asins = parseAsins(getEnv('ASIN'))
  assert(asins.length, 'ASIN is required')

  for (const asin of asins) {
    const file = await exportEpub(asin)
    console.log(`${asin} -> ${file}`)
  }
}
