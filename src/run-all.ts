import 'dotenv/config'

import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { getOutputDir } from './paths'
import { ensureConfig } from './setup'
import { assert, getEnv, parseAsins } from './utils'

/**
 * The whole way from an ASIN to a finished book: extract, transcribe, export,
 * verify, clean up.
 *
 * Each step is a separate process on purpose. They are individually restartable
 * and skip what is already done, so an interrupted run — a crash, a closed lid,
 * a lost network — is resumed by simply starting this again.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const run = promisify(execFile)

const steps = [
  { script: 'extract-kindle-book.ts', label: 'Extracting page images' },
  { script: 'transcribe-book-content.ts', label: 'Transcribing with OCR' },
  { script: 'finalize-book.ts', label: 'Building EPUB/PDF and cleaning up' }
] as const

// Ask for everything up front rather than stopping halfway through the run to
// prompt for a key.
await ensureConfig([
  'AMAZON_EMAIL',
  'AMAZON_PASSWORD',
  'ASIN',
  'MISTRAL_API_KEY'
])

const asins = parseAsins(getEnv('ASIN'))
assert(asins.length, 'ASIN is required')

console.log(
  `\n${asins.length} book(s): ${asins.join(', ')}\n` +
    `Results will end up in ${getOutputDir()}\n`
)

for (const [i, step] of steps.entries()) {
  console.log(`\n━━━ Step ${i + 1}/${steps.length}: ${step.label} ━━━\n`)

  try {
    const { stdout, stderr } = await run(
      'npx',
      ['tsx', path.join(here, step.script)],
      // eslint-disable-next-line no-process-env -- child steps need the same env
      { env: process.env, maxBuffer: 64 * 1024 * 1024 }
    )
    if (stdout.trim()) console.log(stdout.trimEnd())
    if (stderr.trim()) console.error(stderr.trimEnd())
  } catch (err: any) {
    if (err?.stdout?.trim()) console.log(err.stdout.trimEnd())
    if (err?.stderr?.trim()) console.error(err.stderr.trimEnd())

    throw new Error(
      `Step ${i + 1} (${step.script}) failed. Nothing after it ran.\n` +
        `Fix the cause and start again — finished books are skipped, so only ` +
        `what is missing is redone.`
    )
  }
}

console.log(`\n✓ Done. Your books are in ${getOutputDir()}\n`)
