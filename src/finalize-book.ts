import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk } from './types'
import { exportEpub } from './export-book-epub'
import { exportPdf } from './export-book-pdf'
import { bookOutputDir, bookWorkDir, getOutputDir } from './paths'
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

/**
 * The one gate before anything is deleted: are the exports there, and do they
 * carry the whole book? A file that exists but holds a fraction of the text
 * would otherwise pass unnoticed and the sources be gone.
 *
 * The screenshots are the only way to redo an OCR run without downloading the
 * book from Amazon again, so this errs on the side of keeping them.
 */
async function verifyBeforeCleanup(asin: string): Promise<Check> {
  const outDir = bookWorkDir(asin)

  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  const content = await tryReadJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )

  if (!metadata?.pages?.length)
    return { ok: false, reason: 'metadata.json missing or empty' }
  if (!content?.length)
    return { ok: false, reason: 'content.json missing or empty' }

  const missing = metadata.pages.length - content.length
  if (missing > maxMissingPages) {
    return {
      ok: false,
      reason: `${missing} of ${metadata.pages.length} pages were not transcribed`
    }
  }

  const characters = content.reduce((sum, chunk) => sum + chunk.text.length, 0)

  for (const [file, minRatio] of [
    ['book.epub', 0.25],
    ['book.pdf', 0.1]
  ] as const) {
    const stat = await fs.stat(path.join(outDir, file)).catch(() => undefined)
    if (!stat) return { ok: false, reason: `${file} was not created` }

    // Both formats compress, so compare generously — this catches a truncated
    // or near-empty file, not small differences in encoding.
    if (stat.size < characters * minRatio) {
      return {
        ok: false,
        reason: `${file} is only ${stat.size} bytes for ${characters} characters of text`
      }
    }
  }

  return { ok: true }
}

/**
 * Moves the four keepers to the output directory and drops the rest.
 *
 * The working directory holds hundreds of megabytes per book — screenshots and
 * a full browser profile — which nobody needs once the book is exported. The
 * results are small enough to live in the documents folder, where a cloud sync
 * is welcome rather than a burden.
 */
async function moveResultsAndCleanUp(asin: string): Promise<number> {
  const workDir = bookWorkDir(asin)
  const outputDir = bookOutputDir(asin)

  const freed = await directorySize(workDir)
  await fs.mkdir(outputDir, { recursive: true })

  for (const file of [
    'book.epub',
    'book.pdf',
    'content.json',
    'metadata.json'
  ]) {
    const from = path.join(workDir, file)
    const to = path.join(outputDir, file)

    // rename() fails across filesystems, so fall back to copying.
    await fs.rename(from, to).catch(async () => {
      await fs.copyFile(from, to)
      await fs.rm(from, { force: true })
    })
  }

  if (keepPages) {
    await fs
      .rename(path.join(workDir, 'pages'), path.join(outputDir, 'pages'))
      .catch(() => {})
  }

  await fs.rm(workDir, { recursive: true, force: true })
  return freed - (await directorySize(outputDir))
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
  // The exports read metadata.json and content.json and fail loudly if either
  // is missing, so they double as the entry check.
  console.log('  exporting')
  await exportEpub(asin)
  await exportPdf(asin)

  const check = await verifyBeforeCleanup(asin)
  if (!check.ok) {
    throw new Error(`${check.reason} — nothing deleted`)
  }

  const freed = await moveResultsAndCleanUp(asin)
  console.log(`  done — ${bookOutputDir(asin)}, freed ${mb(freed)}`)
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
  `\n${asins.length - failures} of ${asins.length} book(s) finalized, ` +
    `${mb(freedTotal)} freed\nResults in ${getOutputDir()}`
)

if (failures) {
  throw new Error(
    `${failures} of ${asins.length} book(s) could not be finalized`
  )
}
