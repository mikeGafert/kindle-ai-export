import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { exportEpub } from './export-book-epub'
import { exportPdf } from './export-book-pdf'
import { assert, getEnv, parseAsins, tryReadJsonFile } from './utils'

/**
 * Turns a transcribed book into its final formats and then reclaims the disk
 * space taken by the working files.
 *
 * The order matters: nothing is deleted before the exports exist and have been
 * checked, because the screenshots are the only way to redo an OCR run without
 * downloading the whole book from Amazon again.
 */

/** How much of a book may be missing before it is not considered finished. */
const maxMissingPages = Number.parseInt(getEnv('MAX_MISSING_PAGES') ?? '5', 10)

/** Keep the page screenshots (they are the bulk of the disk usage). */
const keepPages = !!getEnv('KEEP_PAGES')

type Check = { ok: boolean; reason?: string }

async function checkTranscription(asin: string): Promise<Check> {
  const outDir = path.join('out', asin)

  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  if (!metadata) return { ok: false, reason: 'metadata.json missing' }
  if (!metadata.complete) return { ok: false, reason: 'extraction incomplete' }
  if (!metadata.pages?.length) return { ok: false, reason: 'no pages recorded' }

  const content = await tryReadJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )
  if (!content?.length) return { ok: false, reason: 'content.json missing' }

  const missing = metadata.pages.length - content.length
  if (missing > maxMissingPages) {
    return {
      ok: false,
      reason: `${missing} of ${metadata.pages.length} pages were not transcribed`
    }
  }

  const empty = content.filter((chunk) => !chunk.text.trim()).length
  if (empty > content.length * 0.2) {
    return {
      ok: false,
      reason: `${empty} of ${content.length} transcribed pages are empty`
    }
  }

  const characters = content.reduce((sum, chunk) => sum + chunk.text.length, 0)
  if (characters < content.length * 100) {
    return {
      ok: false,
      reason: `only ${characters} characters for ${content.length} pages — suspiciously little text`
    }
  }

  return { ok: true }
}

/**
 * Verifies the exports actually carry the book: a file that exists but holds a
 * fraction of the text would otherwise pass unnoticed and the sources be gone.
 */
async function checkExports(asin: string, characters: number): Promise<Check> {
  const outDir = path.join('out', asin)

  for (const [file, minRatio] of [
    ['book.epub', 0.25],
    ['book.pdf', 0.1]
  ] as const) {
    const stat = await fs.stat(path.join(outDir, file)).catch(() => undefined)
    if (!stat) return { ok: false, reason: `${file} was not created` }

    // Both formats compress, so compare generously — this catches a truncated
    // or near-empty file, not small differences in encoding.
    const minBytes = characters * minRatio
    if (stat.size < minBytes) {
      return {
        ok: false,
        reason: `${file} is only ${stat.size} bytes for ${characters} characters of text`
      }
    }
  }

  return { ok: true }
}

async function cleanUp(asin: string): Promise<number> {
  const outDir = path.join('out', asin)
  let freed = 0

  const removable = keepPages ? ['data'] : ['data', 'pages']

  for (const dir of removable) {
    const target = path.join(outDir, dir)
    freed += await directorySize(target)
    await fs.rm(target, { recursive: true, force: true })
  }

  return freed
}

async function directorySize(dir: string): Promise<number> {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => undefined)
  if (!entries) return 0

  let total = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory()
      ? await directorySize(full)
      : ((await fs.stat(full).catch(() => undefined))?.size ?? 0)
  }

  return total
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

async function finalize(asin: string): Promise<{ freed: number }> {
  const transcription = await checkTranscription(asin)
  if (!transcription.ok) {
    throw new Error(`not ready: ${transcription.reason}`)
  }

  const content = (await tryReadJsonFile<ContentChunk[]>(
    path.join('out', asin, 'content.json')
  ))!
  const characters = content.reduce((sum, chunk) => sum + chunk.text.length, 0)

  console.log(`  exporting (${content.length} pages, ${characters} characters)`)
  await exportEpub(asin)
  await exportPdf(asin)

  const exports = await checkExports(asin, characters)
  if (!exports.ok) {
    throw new Error(`export check failed: ${exports.reason} — nothing deleted`)
  }

  const freed = await cleanUp(asin)
  console.log(`  done — freed ${mb(freed)}`)
  return { freed }
}

const asins = parseAsins(getEnv('ASIN'))
assert(asins.length, 'ASIN is required')

let failures = 0
let freedTotal = 0

for (const [i, asin] of asins.entries()) {
  console.log(`\n===== [${i + 1}/${asins.length}] ${asin} =====`)

  try {
    const { freed } = await finalize(asin)
    freedTotal += freed
  } catch (err) {
    ++failures
    console.error(
      `  !! ${asin}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

console.log(
  `\n${asins.length - failures} of ${asins.length} book(s) finalized, ${mb(freedTotal)} freed`
)

if (failures) {
  throw new Error(
    `${failures} of ${asins.length} book(s) could not be finalized`
  )
}
