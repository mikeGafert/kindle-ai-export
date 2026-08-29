import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { getChapters } from './book-structure'
import { bookWorkDir } from './paths'
import { assert, getEnv, parseAsins, readJsonFile } from './utils'

/**
 * Rewritten to use the shared chapter splitting.
 *
 * The previous version had its own copy of that logic with two faults: it
 * never rendered the last TOC entry (its loop stopped one short), and for
 * books without page numbers — where every TOC entry says page 1 — it produced
 * headings with no text under them at all.
 */
function slug(label: string): string {
  return label
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

export async function exportMarkdown(asin: string): Promise<string> {
  const outDir = bookWorkDir(asin)
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )

  assert(content.length, `${asin}: no book content found`)
  assert(metadata.meta, `${asin}: invalid book metadata`)

  const chapters = getChapters(metadata, content)

  const toc = chapters
    .map(
      (chapter) =>
        `${'  '.repeat(chapter.depth)}- [${chapter.label}](#${slug(chapter.label)})`
    )
    .join('\n')

  const body = chapters
    .map((chapter) => `## ${chapter.label}\n\n${chapter.text}`)
    .join('\n\n---\n\n')

  const markdown = `# ${metadata.meta.title}

> By ${metadata.meta.authorList.join(', ')}

---

## Inhaltsverzeichnis

${toc}

---

${body}
`

  const markdownPath = path.join(outDir, 'book.md')
  await fs.writeFile(markdownPath, markdown)
  return markdownPath
}

// Allow running this file on its own.
if (path.basename(process.argv[1] ?? '').startsWith('export-book-markdown')) {
  const asins = parseAsins(getEnv('ASIN'))
  assert(asins.length, 'ASIN is required')

  for (const asin of asins) {
    console.log(`${asin} -> ${await exportMarkdown(asin)}`)
  }
}
