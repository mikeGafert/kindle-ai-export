import type { BookMetadata } from './types'

/** Titles longer than this get their subtitle dropped. */
const comfortableTitleLength = 45

/**
 * Builds a readable file name from a book's metadata.
 *
 * Kindle titles are shop listings, not shelf labels: they carry edition notes,
 * genre keywords and long marketing subtitles. On a reader you want the title
 * and the author, which is what this produces.
 */
export function bookFileName(
  metadata: BookMetadata,
  extension: string
): string {
  const title = cleanTitle(metadata.meta?.title ?? 'Unknown')
  const author = metadata.meta?.authorList?.[0]
  const shortAuthor = author ? shortenAuthor(author) : undefined

  // Some titles already start with the author ("H. P. Lovecraft - Die besten
  // Geschichten"); repeating it would be noise.
  const stem =
    shortAuthor && !startsWithAuthor(title, shortAuthor)
      ? `${title} - ${shortAuthor}`
      : title

  return `${sanitize(stem).slice(0, 120)}.${extension}`
}

function cleanTitle(title: string): string {
  let cleaned = title
    // Edition and format notes.
    .replaceAll(
      /\s*\((?:German|English|French|Spanish|Italian) Edition\)/gi,
      ''
    )
    .replaceAll(/\s*\(Kindle Single\)/gi, '')
    .replaceAll(/\s*\[[^\]]*\]/g, '')
    // Publisher and genre tags in brackets, but keep series numbering
    // ("(Metro-Romane 1)") — that is genuinely useful on a shelf.
    .replaceAll(/\s*\(([^)]*)\)/g, (match, inner: string) =>
      /\d/.test(inner) ? match : ''
    )
    .replaceAll(/\s*:\s*/g, ' - ')
    .trim()

  // Drop the subtitle when the whole thing gets unwieldy. "Nine-to-five muss
  // nicht sein! - Eine unfehlbare Anleitung zu finanzieller Freiheit und …"
  // is a blurb, not a name.
  if (cleaned.length > comfortableTitleLength && cleaned.includes(' - ')) {
    const [main] = cleaned.split(' - ')
    if (main && main.trim().length >= 4) cleaned = main.trim()
  }

  return cleaned
}

/** A long author list is cut down to the first name on the cover. */
function shortenAuthor(author: string): string {
  return (
    author
      .split(/\s*[,;]\s*/)
      .slice(0, 2)
      .join(' ')
      .trim() || author
  )
}

function startsWithAuthor(title: string, author: string): boolean {
  const surname = author.split(/\s+/).at(-1)?.toLowerCase()
  if (!surname || surname.length < 3) return false
  return (
    title.toLowerCase().startsWith(author.toLowerCase()) ||
    title.toLowerCase().startsWith(surname)
  )
}

/** Removes what file systems, FAT volumes and e-readers stumble over. */
function sanitize(name: string): string {
  return name
    .replaceAll(/[/\\:*?"<>|]/g, '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/^[\s.]+|[\s.]+$/g, '')
    .trim()
}
