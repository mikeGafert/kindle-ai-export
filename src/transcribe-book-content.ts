import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import pMap from 'p-map'

import type { BookMetadata, ContentChunk, TocItem } from './types'
import {
  assert,
  getEnv,
  parseAsins,
  readJsonFile,
  tryReadJsonFile
} from './utils'

/**
 * Anthropic model used to transcribe each page screenshot.
 *
 * Defaults to `claude-sonnet-5`. `claude-haiku-4-5` is cheaper but was caught
 * inventing text on decorated title pages — it read a chapter heading that was
 * not on the page, differently on each attempt. A plausible-looking invention
 * is worse than a typo here, because nothing downstream will flag it. Use
 * `claude-opus-5` for difficult typography; override via `ANTHROPIC_MODEL`.
 */
const model = getEnv('ANTHROPIC_MODEL') ?? 'claude-sonnet-5'

/** `output_config.effort` is supported on the 4.6+ Opus/Sonnet/Fable families. */
const supportsEffort = /^claude-(opus|sonnet|fable|mythos)-(5|4-[678])/.test(
  model
)

/** Server-side refusal fallbacks are available on Opus 5 / Fable 5 / Mythos 5. */
const supportsRefusalFallbacks = /^claude-(opus|fable|mythos)-5/.test(model)

const concurrency = Number.parseInt(getEnv('TRANSCRIBE_CONCURRENCY') ?? '8', 10)

/** Transcribe only the first N pages — useful for a cheap trial run. */
const limit = Number.parseInt(getEnv('TRANSCRIBE_LIMIT') ?? '0', 10)

const blankMarker = '[[BLANK]]'

const systemPrompt = `You will be given an image of a single page from an ebook. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown. Never describe the image or comment on what you see.

If the page contains no readable text at all, output exactly ${blankMarker} and nothing else.`

async function main(asin: string) {
  const outDir = path.join('out', asin)
  const metadataPath = path.join(outDir, 'metadata.json')
  const metadata = await readJsonFile<BookMetadata>(metadataPath).catch(() => {
    throw new Error(
      `${metadataPath} not found — run "npx tsx src/extract-kindle-book.ts" for this book first`
    )
  })
  assert(metadata.pages?.length, 'no page screenshots found')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const pageToTocItemMap = metadata.toc.reduce(
    (acc, tocItem) => {
      if (tocItem.page !== undefined) {
        acc[tocItem.page] = tocItem
      }
      return acc
    },
    {} as Record<number, TocItem>
  )

  // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
  // `ant auth login` profile.
  const client = new Anthropic({ maxRetries: 5 })

  const pages = limit > 0 ? metadata.pages.slice(0, limit) : metadata.pages
  if (limit > 0) {
    console.log(
      `TRANSCRIBE_LIMIT=${limit}: only transcribing the first ${pages.length} of ${metadata.pages.length} pages`
    )
  }

  const content: ContentChunk[] = (
    await pMap(
      pages,
      async (pageChunk, pageChunkIndex) => {
        const { screenshot, index, page } = pageChunk
        const screenshotBuffer = await fs.readFile(screenshot)
        // NOTE: Anthropic expects bare base64 — no `data:image/png;base64,` prefix.
        const screenshotBase64 = screenshotBuffer.toString('base64')

        try {
          const maxRetries = 5
          let retries = 0

          do {
            const res = await client.beta.messages.create({
              model,
              max_tokens: 8192,
              system: systemPrompt,
              ...(supportsEffort
                ? { output_config: { effort: 'low' as const } }
                : {}),
              ...(supportsRefusalFallbacks
                ? {
                    betas: ['server-side-fallback-2026-07-01'],
                    fallbacks: 'default' as const
                  }
                : {}),
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: screenshotBase64
                      }
                    }
                  ]
                }
              ]
            })

            ++retries

            if (res.stop_reason === 'refusal') {
              // The model declined this page (safety classifier). Retrying with
              // a nudged prompt would be an attempt to work around that, so we
              // surface it instead and let the page be re-run manually.
              throw new Error(
                `Model refused to transcribe page ${page} (${screenshot}): ${
                  res.stop_details?.explanation ?? 'no explanation'
                }`
              )
            }

            const rawText = res.content
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n')

            // A deliberately blank page is a valid result, not a failed attempt.
            const isBlank = rawText.trim() === blankMarker

            let text = isBlank
              ? ''
              : rawText
                  .replace(/^\s*\d+\s*$\n+/m, '')
                  .replaceAll(/^\s*/gm, '')
                  .replaceAll(/\s*$/gm, '')

            if (!text && !isBlank) {
              if (retries >= maxRetries) {
                throw new Error(
                  `Empty transcription after ${retries} attempts for page ${page} (${screenshot})`
                )
              }

              console.warn('retrying empty transcription...', {
                index,
                screenshot
              })
              continue
            }

            const prevPageChunk = metadata.pages[pageChunkIndex - 1]
            if (prevPageChunk && prevPageChunk.page !== page) {
              const tocItem = pageToTocItemMap[page]
              if (tocItem) {
                text = text.replace(
                  // eslint-disable-next-line security/detect-non-literal-regexp
                  new RegExp(`^${tocItem.label}\\s*`, 'i'),
                  ''
                )
              }
            }

            const result: ContentChunk = {
              index,
              page,
              text,
              screenshot
            }
            console.log(result)

            return result
          } while (true)
        } catch (err) {
          console.error(`error processing image ${index} (${screenshot})`, err)
        }
      },
      { concurrency }
    )
  ).filter(Boolean)

  const contentPath = path.join(outDir, 'content.json')
  await fs.writeFile(contentPath, JSON.stringify(content, null, 2))
  console.log(
    `\ntranscribed ${content.length} of ${pages.length} pages -> ${contentPath}`
  )
}

const asins = parseAsins(getEnv('ASIN'))
assert(
  asins.length,
  'ASIN is required (single value, comma-separated list or JSON array)'
)

let failures = 0

/**
 * Transcription costs money per page, so a book that already has a complete
 * `content.json` is skipped — otherwise restarting a long run would pay for the
 * same pages twice.
 */
async function isAlreadyTranscribed(asin: string): Promise<boolean> {
  const outDir = path.join('out', asin)
  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  if (!metadata?.pages?.length) return false

  const content = await tryReadJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )

  // Allow for the odd page the model refused or failed on.
  return !!content && content.length >= metadata.pages.length - 5
}

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
