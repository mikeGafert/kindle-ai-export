import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata } from './types'
import { bookFileName } from './export-book-names'
import { getOutputDir } from './paths'
import { assert, getEnv, tryReadJsonFile } from './utils'

/**
 * Copies the finished books to an e-reader (or any folder) under readable
 * names.
 *
 * The export directories are named by ASIN, which is right for a pipeline and
 * useless on a bookshelf. Nothing is deleted here — the export stays as it is.
 */
const target = getEnv('READER_DIR')
assert(
  target,
  'READER_DIR is required — the folder to copy into, e.g. ' +
    '/run/media/you/PB743G/Books'
)

const format = (getEnv('READER_FORMAT') ?? 'epub').toLowerCase()
assert(
  ['epub', 'pdf', 'both'].includes(format),
  `READER_FORMAT must be epub, pdf or both (got "${format}")`
)

const extensions = format === 'both' ? ['epub', 'pdf'] : [format]
const sourceDir = getOutputDir()

const entries = await fs.readdir(sourceDir, { withFileTypes: true })
const books = entries.filter((entry) => entry.isDirectory())
assert(books.length, `no exported books found in ${sourceDir}`)

await fs.mkdir(target, { recursive: true })

let copied = 0
let skipped = 0

for (const book of books) {
  const bookDir = path.join(sourceDir, book.name)
  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(bookDir, 'metadata.json')
  )

  if (!metadata?.meta) {
    console.warn(`  ! ${book.name}: no metadata, skipping`)
    ++skipped
    continue
  }

  for (const extension of extensions) {
    const from = path.join(bookDir, `book.${extension}`)
    const source = await fs.stat(from).catch(() => undefined)

    if (!source) {
      console.warn(`  ! ${book.name}: no book.${extension}`)
      ++skipped
      continue
    }

    const name = bookFileName(metadata, extension)
    const to = path.join(target, name)

    // Copying over USB is slow, so skip what is already there unchanged and
    // make a second run cheap.
    const existing = await fs.stat(to).catch(() => undefined)
    if (existing && existing.size === source.size) {
      console.log(`  = ${name}`)
      continue
    }

    await fs.copyFile(from, to)
    console.log(`  → ${name}`)
    ++copied
  }
}

console.log(
  `\n${copied} file(s) copied to ${target}${skipped ? `, ${skipped} skipped` : ''}`
)
