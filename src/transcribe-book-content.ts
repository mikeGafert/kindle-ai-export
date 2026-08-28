import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import pMap from 'p-map'

import type { BookMetadata, ContentChunk, TocItem } from './types'
import { assert, getEnv, readJsonFile } from './utils'

/**
 * Anthropic model used to transcribe each page screenshot.
 *
 * Defaults to `claude-haiku-4-5`, which is by far the cheapest option for what
 * is essentially OCR. Override via the `ANTHROPIC_MODEL` env var if a book's
 * typography or layout needs a stronger model (e.g. `claude-opus-5`).
 */
const model = getEnv('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5'

/** `output_config.effort` is supported on the 4.6+ Opus/Sonnet/Fable families. */
const supportsEffort = /^claude-(opus|sonnet|fable|mythos)-(5|4-[678])/.test(
  model
)

/** Server-side refusal fallbacks are available on Opus 5 / Fable 5 / Mythos 5. */
const supportsRefusalFallbacks = /^claude-(opus|fable|mythos)-5/.test(model)

const concurrency = Number.parseInt(getEnv('TRANSCRIBE_CONCURRENCY') ?? '8', 10)

const systemPrompt = `You will be given an image of a single page from an ebook. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.`

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
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

  const content: ContentChunk[] = (
    await pMap(
      metadata.pages,
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

            let text = rawText
              .replace(/^\s*\d+\s*$\n+/m, '')
              .replaceAll(/^\s*/gm, '')
              .replaceAll(/\s*$/gm, '')

            if (!text) {
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

  await fs.writeFile(
    path.join(outDir, 'content.json'),
    JSON.stringify(content, null, 2)
  )
  console.log(JSON.stringify(content, null, 2))
}

await main()
