import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { Mistral } from '@mistralai/mistralai'
import pMap from 'p-map'

import type { BookMetadata, ContentChunk, PageChunk, TocItem } from './types'
import { bookWorkDir } from './paths'
import { ensureConfig } from './setup'
import {
  assert,
  getEnv,
  parseAsins,
  readJsonFile,
  tryReadJsonFile
} from './utils'

/**
 * Transcribes the page screenshots with Mistral's OCR models through the batch
 * API, which is half the price of the synchronous endpoint.
 *
 * A dedicated OCR engine is used rather than a vision LLM on purpose: an LLM
 * reads a page *and understands it*, which makes it prone to quietly smoothing
 * or inventing text — during testing a vision model produced a chapter heading
 * that was not on the page at all. OCR only recognises glyphs.
 */
const model = getEnv('MISTRAL_OCR_MODEL') ?? 'mistral-ocr-3'

/**
 * Pages per batch job. The request file carries every screenshot as base64, so
 * a whole large book in one file would run into the upload size limit.
 */
const batchSize = Number.parseInt(getEnv('MISTRAL_BATCH_SIZE') ?? '400', 10)

/**
 * `batch` is half the price but has to be unlocked separately in the Mistral
 * console (it answers 402 otherwise); `sync` posts each page to /v1/ocr.
 * `auto` tries batch first and falls back to sync when it is not available.
 */
const mode = getEnv('MISTRAL_MODE') ?? 'auto'

/** Parallel requests in sync mode. Raise it if your rate limit allows. */
const concurrency = Number.parseInt(getEnv('MISTRAL_CONCURRENCY') ?? '5', 10)

/** Transcribe only the first N pages — useful for a cheap trial run. */
const limit = Number.parseInt(getEnv('TRANSCRIBE_LIMIT') ?? '0', 10)

/** How long to wait for a batch job before giving up (minutes). */
const jobTimeoutMinutes = Number.parseInt(
  getEnv('MISTRAL_JOB_TIMEOUT_MINUTES') ?? '180',
  10
)

await ensureConfig(['MISTRAL_API_KEY', 'ASIN'])

const apiKey = getEnv('MISTRAL_API_KEY')
assert(
  apiKey,
  'MISTRAL_API_KEY is required — create one at https://console.mistral.ai/api-keys'
)

const client = new Mistral({ apiKey })

/**
 * Fails early with the list of models the account can actually use, instead of
 * letting a typo surface as an opaque error once the batch is already running.
 */
async function assertModelAvailable() {
  const models = await client.models.list().catch(() => undefined)
  if (!models?.data) return // can't verify — let the batch call report it

  const ids = models.data.flatMap((m) =>
    'id' in m && typeof m.id === 'string' ? [m.id] : []
  )
  if (ids.includes(model)) return

  const ocrModels = ids.filter((id) => id.includes('ocr')).toSorted()
  throw new Error(
    `Model "${model}" is not available for this account.\n` +
      `OCR models you can use: ${ocrModels.join(', ') || '(none found)'}\n` +
      `Set MISTRAL_OCR_MODEL in .env to one of them.`
  )
}

/** One JSONL line per page, in the raw (snake_case) shape the API expects. */
async function buildBatchFile(pages: PageChunk[]): Promise<Buffer> {
  const lines: string[] = []

  for (const pageChunk of pages) {
    const image = await fs.readFile(pageChunk.screenshot)
    lines.push(
      JSON.stringify({
        custom_id: `${pageChunk.index}`,
        body: {
          document: {
            type: 'image_url',
            image_url: `data:image/png;base64,${image.toString('base64')}`
          }
        }
      })
    )
  }

  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

async function runBatch(
  pages: PageChunk[],
  label: string
): Promise<Map<number, string>> {
  const content = await buildBatchFile(pages)
  console.log(
    `  ${label}: uploading ${pages.length} pages (${(content.length / 1024 / 1024).toFixed(1)} MB)`
  )

  const inputFile = await client.files.upload({
    file: { fileName: `${label}.jsonl`, content },
    purpose: 'batch'
  })

  const created = await client.batch.jobs.create({
    inputFiles: [inputFile.id],
    model,
    endpoint: '/v1/ocr',
    timeoutHours: 24
  })

  console.log(`  ${label}: job ${created.id} submitted, waiting...`)

  const deadline = Date.now() + jobTimeoutMinutes * 60_000
  let job = created

  while (job.status === 'QUEUED' || job.status === 'RUNNING') {
    if (Date.now() > deadline) {
      throw new Error(
        `batch job ${job.id} still ${job.status} after ${jobTimeoutMinutes} minutes`
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 10_000))
    job = await client.batch.jobs.get({ jobId: created.id })
  }

  if (job.status !== 'SUCCESS') {
    throw new Error(`batch job ${job.id} ended with status ${job.status}`)
  }

  assert(job.outputFile, `batch job ${job.id} produced no output file`)
  console.log(
    `  ${label}: done (${job.succeededRequests ?? 0} ok, ${job.failedRequests ?? 0} failed)`
  )

  const download = await client.files.download({ fileId: job.outputFile })
  const raw = await new Response(download).text()

  const texts = new Map<number, string>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue

    const entry: any = JSON.parse(line)
    const index = Number.parseInt(entry.custom_id, 10)

    if (entry.error || entry.response?.status_code !== 200) {
      console.warn(
        `  ! page index ${index} failed:`,
        JSON.stringify(entry.error ?? entry.response?.status_code)
      )
      continue
    }

    // One screenshot is one page, so the response carries a single page entry.
    const markdown: string = (entry.response.body.pages ?? [])
      .map((p: { markdown?: string }) => p.markdown ?? '')
      .join('\n')
      .trim()

    texts.set(index, markdown)
  }

  return texts
}

/** Posts each page to /v1/ocr directly, with limited concurrency. */
async function runSync(
  pages: PageChunk[],
  label: string
): Promise<Map<number, string>> {
  console.log(`  ${label}: ${pages.length} pages, ${concurrency} at a time`)
  const texts = new Map<number, string>()
  let done = 0

  await pMap(
    pages,
    async (pageChunk) => {
      const image = await fs.readFile(pageChunk.screenshot)

      for (let attempt = 0; attempt < 5; ++attempt) {
        try {
          const res = await client.ocr.process({
            model,
            document: {
              type: 'image_url',
              imageUrl: `data:image/png;base64,${image.toString('base64')}`
            }
          })

          texts.set(
            pageChunk.index,
            (res.pages ?? [])
              .map((p) => p.markdown ?? '')
              .join('\n')
              .trim()
          )
          break
        } catch (err: any) {
          // Back off on rate limits, give up on anything else.
          if (err?.statusCode !== 429 || attempt === 4) {
            console.warn(
              `  ! page ${pageChunk.page} failed:`,
              err?.statusCode ?? err
            )
            break
          }
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }

      if (++done % 50 === 0) console.log(`  ${label}: ${done}/${pages.length}`)
    },
    { concurrency }
  )

  return texts
}

/**
 * Mistral returns structured Markdown. For a plain-text book export the markup
 * is noise, so strip what the OCR added while leaving the words untouched.
 */
function stripMarkdown(text: string): string {
  return (
    text
      // Image placeholders for figures the OCR could not read as text.
      .replaceAll(/!\[[^\]]*]\([^)]*\)/g, '')
      // Markdown tables: the reader has none, these come from decorative layout.
      .replaceAll(/^\s*\|[\s|:-]*\|\s*$/gm, '')
      .replaceAll(/^\s*\|(.*)\|\s*$/gm, (_, row: string) =>
        row
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(' ')
      )
      // Heading, quote and list markers — including a bare '#' on its own line,
      // which the OCR emits for a decorative separator.
      .replaceAll(/^\s{0,3}#{1,6}\s*$/gm, '')
      .replaceAll(/^\s{0,3}#{1,6}\s+/gm, '')
      .replaceAll(/^\s{0,3}>\s?/gm, '')
      // Emphasis around whole words, keeping the words.
      .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
      .replaceAll(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/g, '$1')
      // Horizontal rules.
      .replaceAll(/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/gm, '')
      // HTML entities the OCR emits for & < > and friends.
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll(/&#39;|&apos;/g, "'")
      .replaceAll('&nbsp;', ' ')
      // The OCR occasionally inserts a space before closing punctuation
      // (»Nirgendwo «). Note » is the *opening* quote in German and keeps its
      // leading space — only « closes.
      .replaceAll(/ +([,.;:!?«])/g, '$1')
      // Collapse the blank lines the removals leave behind.
      .replaceAll(/\n{3,}/g, '\n\n')
      .trim()
  )
}

async function main(asin: string) {
  const outDir = bookWorkDir(asin)
  const metadataPath = path.join(outDir, 'metadata.json')
  const metadata = await readJsonFile<BookMetadata>(metadataPath).catch(() => {
    throw new Error(
      `${metadataPath} not found — run "npx tsx src/extract-kindle-book.ts" for this book first`
    )
  })

  // Transcribing a partially extracted book would spend money on an incomplete
  // text and leave a content.json that looks finished.
  assert(
    metadata.complete,
    `${asin} was not extracted completely — re-run the extraction for it first`
  )
  assert(metadata.pages?.length, 'no page screenshots found')

  const pageToTocItemMap = (metadata.toc ?? []).reduce(
    (acc, tocItem) => {
      if (tocItem.page !== undefined) acc[tocItem.page] = tocItem
      return acc
    },
    {} as Record<number, TocItem>
  )

  const pages = limit > 0 ? metadata.pages.slice(0, limit) : metadata.pages
  if (limit > 0) {
    console.log(
      `TRANSCRIBE_LIMIT=${limit}: only transcribing the first ${pages.length} of ${metadata.pages.length} pages`
    )
  }

  const texts = new Map<number, string>()
  let useBatch = mode !== 'sync'

  for (let offset = 0; offset < pages.length; offset += batchSize) {
    const slice = pages.slice(offset, offset + batchSize)
    const label = `${asin} ${offset + 1}-${offset + slice.length}`

    let result: Map<number, string> | undefined

    if (useBatch) {
      try {
        result = await runBatch(slice, label)
      } catch (err: any) {
        if (mode === 'batch' || err?.statusCode !== 402) throw err
        console.warn(
          '  ! the batch API is not enabled for this account — falling back to ' +
            'single requests (twice the price per page).\n' +
            '    Enable batch billing in the Mistral console to halve it.'
        )
        useBatch = false
      }
    }

    result ??= await runSync(slice, label)
    for (const [index, text] of result) texts.set(index, text)
  }

  const content: ContentChunk[] = []

  for (const [i, pageChunk] of pages.entries()) {
    const text = texts.get(pageChunk.index)
    if (text === undefined) continue

    let cleaned = stripMarkdown(text)
      .replace(/^\s*\d+\s*$\n+/m, '')
      .replaceAll(/^\s*/gm, '')
      .replaceAll(/\s*$/gm, '')

    // Drop a chapter heading that the reader repeats at the top of the page it
    // starts on; the TOC already carries it.
    const prevPageChunk = pages[i - 1]
    if (prevPageChunk && prevPageChunk.page !== pageChunk.page) {
      const tocItem = pageToTocItemMap[pageChunk.page]
      if (tocItem) {
        cleaned = cleaned.replace(
          // eslint-disable-next-line security/detect-non-literal-regexp
          new RegExp(`^${tocItem.label}\\s*`, 'i'),
          ''
        )
      }
    }

    content.push({
      index: pageChunk.index,
      page: pageChunk.page,
      text: cleaned,
      screenshot: pageChunk.screenshot
    })
  }

  const contentPath = path.join(outDir, 'content.json')
  await fs.writeFile(contentPath, JSON.stringify(content, null, 2))
  console.log(
    `\ntranscribed ${content.length} of ${pages.length} pages -> ${contentPath}`
  )
}

/**
 * Transcription costs money per page, so a book that already has a complete
 * `content.json` is skipped — otherwise restarting a long run would pay for the
 * same pages twice.
 */
async function isAlreadyTranscribed(asin: string): Promise<boolean> {
  const outDir = bookWorkDir(asin)
  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  if (!metadata?.pages?.length) return false

  const content = await tryReadJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )

  // Allow for the odd page the engine could not read.
  return !!content && content.length >= metadata.pages.length - 5
}

const asins = parseAsins(getEnv('ASIN'))
assert(
  asins.length,
  'ASIN is required (single value, comma-separated list or JSON array)'
)

await assertModelAvailable()
console.log(`transcribing with ${model} via the batch API\n`)

let failures = 0

for (const [i, asin] of asins.entries()) {
  if (asins.length > 1) {
    console.log(`\n===== [${i + 1}/${asins.length}] ${asin} =====\n`)
  }

  try {
    if (!getEnv('FORCE_RETRANSCRIBE') && (await isAlreadyTranscribed(asin))) {
      console.log(
        `${asin} already transcribed, skipping (FORCE_RETRANSCRIBE=1 to redo)`
      )
      continue
    }

    await main(asin)
  } catch (err) {
    ++failures
    console.error(`\n!! failed to transcribe ${asin}:`, err)
  }
}

if (failures) {
  throw new Error(`${failures} of ${asins.length} book(s) failed`)
}
