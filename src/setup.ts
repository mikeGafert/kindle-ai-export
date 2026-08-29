import fs from 'node:fs/promises'
import path from 'node:path'

import { confirm, input, password } from '@inquirer/prompts'

import { getEnv } from './utils'

const envPath = path.join(process.cwd(), '.env')

export type SettingKey =
  | 'AMAZON_EMAIL'
  | 'AMAZON_PASSWORD'
  | 'AMAZON_TOTP_SECRET'
  | 'ASIN'
  | 'MISTRAL_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'OUTPUT_DIR'

type Setting = {
  key: SettingKey
  label: string
  hint?: string
  secret?: boolean
  optional?: boolean
  validate?: (value: string) => true | string
}

const settings: Record<SettingKey, Setting> = {
  AMAZON_EMAIL: {
    key: 'AMAZON_EMAIL',
    label: 'Amazon email address',
    hint: 'the account whose Kindle library holds the books',
    validate: (v) =>
      v.includes('@') ? true : 'that does not look like an email address'
  },
  AMAZON_PASSWORD: {
    key: 'AMAZON_PASSWORD',
    label: 'Amazon password',
    secret: true
  },
  AMAZON_TOTP_SECRET: {
    key: 'AMAZON_TOTP_SECRET',
    label: 'Amazon 2FA secret (base32)',
    hint: 'optional — leave empty to type the code by hand when asked',
    secret: true,
    optional: true,
    validate: (v) =>
      !v || /^[A-Z2-7\s]+$/i.test(v)
        ? true
        : 'a TOTP secret is base32: letters A-Z and digits 2-7 only'
  },
  ASIN: {
    key: 'ASIN',
    label: 'Book ASIN(s)',
    hint: 'from the reader URL, e.g. B07QLY87NH — several separated by commas',
    validate: (v) =>
      v
        .split(/[,;\s]+/)
        .filter(Boolean)
        .every((a) => /^[A-Z0-9]{10}$/i.test(a))
        ? true
        : 'an ASIN is 10 characters, e.g. B07QLY87NH'
  },
  MISTRAL_API_KEY: {
    key: 'MISTRAL_API_KEY',
    label: 'Mistral API key',
    hint: 'from https://console.mistral.ai/api-keys — billing must be enabled',
    secret: true
  },
  OUTPUT_DIR: {
    key: 'OUTPUT_DIR',
    label: 'Where should the finished books go',
    hint: 'leave empty for the default in your documents folder',
    optional: true
  },
  ANTHROPIC_API_KEY: {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    hint: 'from https://console.anthropic.com — only for the Claude variant',
    secret: true
  }
}

async function readEnvFile(): Promise<Map<string, string>> {
  const values = new Map<string, string>()
  const raw = await fs.readFile(envPath, 'utf8').catch(() => '')

  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (match) values.set(match[1]!, match[2]!)
  }

  return values
}

/**
 * Adds or replaces keys in .env, leaving comments and unrelated lines alone so
 * a hand-maintained file survives.
 */
async function writeEnvFile(updates: Map<string, string>) {
  const raw = await fs.readFile(envPath, 'utf8').catch(() => '')
  const lines = raw ? raw.split('\n') : []
  const pending = new Map(updates)

  const merged = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/)
    const key = match?.[1]

    if (key && pending.has(key)) {
      const value = pending.get(key)!
      pending.delete(key)
      return `${key}=${value}`
    }

    return line
  })

  if (pending.size) {
    if (merged.length && merged.at(-1) !== '') merged.push('')
    for (const [key, value] of pending) merged.push(`${key}=${value}`)
    merged.push('')
  }

  await fs.writeFile(envPath, merged.join('\n'), { mode: 0o600 })
  await fs.chmod(envPath, 0o600).catch(() => {})
}

/**
 * Asks for any of the given settings that are still missing and stores them in
 * .env, so a fresh checkout can be set up without editing files by hand.
 *
 * Values already present are never touched. In a non-interactive shell nothing
 * is asked — the caller's own assert reports what is missing instead.
 */
export async function ensureConfig(required: SettingKey[]): Promise<void> {
  const stored = await readEnvFile()
  const isSet = (key: SettingKey) =>
    !!(getEnv(key)?.trim() || stored.get(key)?.trim())

  const missing = required.filter((key) => !isSet(key))
  if (!missing.length) return

  if (!process.stdin.isTTY) {
    // Running detached (nohup, cron, CI): asking would hang forever.
    throw new Error(
      `Missing configuration: ${missing.join(', ')}. ` +
        `Run this once in an interactive terminal to set it up, or add the ` +
        `values to .env yourself.`
    )
  }

  console.log(
    `\nSetting up ${path.basename(envPath)} — ${missing.length} value(s) missing.` +
      `\nThey are stored locally in .env (git-ignored, mode 600).\n`
  )

  const updates = new Map<string, string>()

  for (const key of missing) {
    const setting = settings[key]
    const message = setting.hint
      ? `${setting.label} (${setting.hint}):`
      : `${setting.label}:`

    const answer = setting.secret
      ? await password({ message, mask: '*' })
      : await input({ message, validate: setting.validate })

    const value = answer.trim()

    if (!value) {
      if (!setting.optional) {
        throw new Error(`${setting.label} is required`)
      }
      // Remember the deliberate skip so we do not ask again next run.
      updates.set(key, '')
      continue
    }

    if (setting.secret && setting.validate) {
      const verdict = setting.validate(value)
      if (verdict !== true) throw new Error(`${setting.label}: ${verdict}`)
    }

    updates.set(key, value)
    // Make it visible to the current run as well, not just the next one.
    // eslint-disable-next-line no-process-env
    process.env[key] = value
  }

  await writeEnvFile(updates)
  console.log(`\nSaved to ${envPath}\n`)
}

/**
 * Asked once when no TOTP secret is configured, so the user knows a code may be
 * requested and the run will not silently stall.
 */
export async function confirmManual2fa(): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  return confirm({
    message:
      'No 2FA secret configured. Stay at the keyboard in case Amazon asks for a code?',
    default: true
  })
}
