import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getEnv } from './utils'

const appName = 'kindle-ai-export'

/**
 * Where the working files live: page screenshots and the browser profile, a few
 * hundred megabytes per book. Deliberately *not* the documents folder — that is
 * often synced to a cloud, and nobody wants a browser profile replicated to
 * every device.
 */
export function getWorkDir(): string {
  const configured = getEnv('WORK_DIR')
  if (configured) return path.resolve(untilde(configured))

  // An existing ./out from an earlier run keeps working.
  const legacy = path.resolve('out')
  if (fsSync.existsSync(legacy)) return legacy

  const home = os.homedir()

  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', appName)
    case 'win32':
      return path.join(
        getEnv('LOCALAPPDATA') || path.join(home, 'AppData', 'Local'),
        appName
      )
    default:
      return path.join(
        getEnv('XDG_DATA_HOME') || path.join(home, '.local', 'share'),
        appName
      )
  }
}

/**
 * Where the finished books go: EPUB, PDF and the JSON they were built from.
 * This is meant to be a place the user actually browses, so it defaults to the
 * documents folder — syncing these few megabytes is usually welcome.
 */
export function getOutputDir(): string {
  const configured = getEnv('OUTPUT_DIR')
  if (configured) return path.resolve(untilde(configured))

  return path.join(getDocumentsDir(), 'Kindle-Export')
}

/** Best effort at the localized documents folder ("Dokumente", "Documents"). */
function getDocumentsDir(): string {
  const home = os.homedir()

  if (process.platform === 'linux') {
    // XDG stores the localized name in user-dirs.dirs.
    const configHome = getEnv('XDG_CONFIG_HOME') || path.join(home, '.config')
    const userDirs = path.join(configHome, 'user-dirs.dirs')

    try {
      const raw = fsSync.readFileSync(userDirs, 'utf8')
      const match = raw.match(/^XDG_DOCUMENTS_DIR="(.+)"$/m)
      if (match?.[1]) {
        const resolved = match[1].replace('$HOME', home)
        if (fsSync.existsSync(resolved)) return resolved
      }
    } catch {
      // fall through to the guesses below
    }
  }

  for (const candidate of ['Documents', 'Dokumente']) {
    const full = path.join(home, candidate)
    if (fsSync.existsSync(full)) return full
  }

  return home
}

/**
 * Refuses configurations in which the work and output directories overlap.
 *
 * finalize-book moves the results into the output directory and then deletes
 * the work directory. If the two are the same — or the output sits inside the
 * work directory — that last step would delete the very files it just saved.
 */
export function assertDirectoriesDoNotOverlap(): void {
  const work = path.resolve(getWorkDir())
  const output = path.resolve(getOutputDir())

  const inside = (a: string, b: string) => a.startsWith(b + path.sep)

  if (work === output || inside(output, work) || inside(work, output)) {
    throw new Error(
      `WORK_DIR and OUTPUT_DIR must not overlap, otherwise finishing a book ` +
        `would delete its own results.\n` +
        `  WORK_DIR:   ${work}\n` +
        `  OUTPUT_DIR: ${output}`
    )
  }
}

/** Working directory for one book. */
export function bookWorkDir(asin: string): string {
  return path.join(getWorkDir(), asin)
}

/** Output directory for one book. */
export function bookOutputDir(asin: string): string {
  return path.join(getOutputDir(), asin)
}

function untilde(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}
