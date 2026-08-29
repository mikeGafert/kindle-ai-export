import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getEnv } from './utils'

/**
 * Finds a Unicode-capable TrueType font for the PDF export.
 *
 * PDFKit's built-in fonts only cover WinAnsi/CP1252. Anything outside it — a
 * ♦ scene break, an → arrow, a ⁴ footnote marker, an ī — is silently dropped
 * with zero width, so the PDF loses characters without any error. Embedding a
 * font avoids that; if none is found we say so rather than quietly degrade.
 */
const candidates = [
  // Linux
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/google-noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  // macOS
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  // Windows
  'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\segoeui.ttf'
]

export type FontChoice = { path: string; name: string } | undefined

export function findUnicodeFont(): FontChoice {
  const configured = getEnv('PDF_FONT')
  if (configured) {
    const resolved = configured.startsWith('~')
      ? path.join(os.homedir(), configured.slice(1))
      : configured

    if (!fsSync.existsSync(resolved)) {
      throw new Error(
        `PDF_FONT points at a file that does not exist: ${resolved}`
      )
    }

    return { path: resolved, name: path.basename(resolved) }
  }

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return { path: candidate, name: path.basename(candidate) }
    }
  }
}
