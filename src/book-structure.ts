import type { BookMetadata, ContentChunk } from './types'

export type Chapter = {
  label: string
  depth: number
  text: string
}

/**
 * Splits a book into chapters.
 *
 * Two shapes have to be handled. Books with page numbers carry usable `page`
 * values in the TOC, and the content chunks are numbered on the same scale.
 * Books without page numbers have an empty location map, so every TOC entry
 * ends up with `page: 1` — there the only usable anchor is `positionId`, which
 * runs on a different scale than the reader's footer counter the chunks are
 * numbered by. Those get mapped proportionally.
 *
 * If neither works out, the whole book becomes a single chapter rather than
 * silently producing an empty export.
 */
export function getChapters(
  metadata: BookMetadata,
  content: ContentChunk[]
): Chapter[] {
  const toc = metadata.toc ?? []
  const usablePages = new Set(
    toc.map((item) => item.page).filter((page) => page !== undefined)
  )

  // More than one distinct page number means the TOC is on the chunks' scale.
  const anchors = dedupeByPosition(
    usablePages.size > 1
      ? toc
          .filter((item) => item.page !== undefined)
          .map((item) => ({
            label: item.label,
            depth: item.depth,
            at: item.page!
          }))
      : toPositionAnchors(metadata, content)
  )

  if (anchors.length < 2) {
    return [singleChapter(metadata, content)]
  }

  const chapters: Chapter[] = []

  for (const [i, anchor] of anchors.entries()) {
    const next = anchors[i + 1]
    const from = content.findIndex((chunk) => chunk.page >= anchor.at)
    const to = next
      ? content.findIndex((chunk) => chunk.page >= next.at)
      : content.length

    if (from === -1) continue

    const text = stripLeadingHeading(
      joinPages(content.slice(from, to === -1 ? content.length : to)),
      anchor.label
    )
    if (!text.trim()) continue

    chapters.push({ label: anchor.label, depth: anchor.depth, text })
  }

  // Anything before the first anchor (cover, imprint) would be lost otherwise.
  const firstAt = anchors[0]!.at
  const preamble = joinPages(content.filter((chunk) => chunk.page < firstAt))
  if (preamble.trim()) {
    chapters.unshift({ label: 'Beginn', depth: 0, text: preamble })
  }

  return chapters.length ? chapters : [singleChapter(metadata, content)]
}

/**
 * The whole book as one chapter, used when the TOC gives us nothing to split
 * on. Still strips a repeated title, same as a real chapter would.
 */
function singleChapter(
  metadata: BookMetadata,
  content: ContentChunk[]
): Chapter {
  const label = metadata.meta?.title ?? 'Book'
  return {
    label,
    depth: 0,
    text: stripLeadingHeading(joinPages(content), label)
  }
}

/**
 * Merges anchors that land on the same page.
 *
 * A part title and its first chapter routinely start on one page ("Teil Eins" /
 * "Kapitel 1"). Left alone, the first of them would produce an empty chapter
 * that is dropped, and its heading would disappear from the book entirely.
 */
function dedupeByPosition(
  anchors: Array<{ label: string; depth: number; at: number }>
): Array<{ label: string; depth: number; at: number }> {
  const merged: Array<{ label: string; depth: number; at: number }> = []

  for (const anchor of anchors) {
    const previous = merged.at(-1)

    if (previous && previous.at === anchor.at) {
      previous.label = `${previous.label} — ${anchor.label}`
      continue
    }

    // Anchors must move forward. One that points backwards (a stray TOC entry,
    // a rounding dip when mapping positions) would make its chapter empty and
    // put the pages before it into two chapters at once.
    if (previous && anchor.at < previous.at) continue

    merged.push({ ...anchor })
  }

  return merged
}

/**
 * Maps TOC `positionId`s onto the footer scale the content chunks use, by
 * proportion between the book's first and last position.
 */
function toPositionAnchors(
  metadata: BookMetadata,
  content: ContentChunk[]
): Array<{ label: string; depth: number; at: number }> {
  const startPosition = metadata.nav?.startPosition ?? 0
  const endPosition = metadata.nav?.endPosition ?? 0
  const span = endPosition - startPosition

  if (span <= 0 || content.length < 2) return []

  const first = content[0]!.page
  const last = content.at(-1)!.page
  const footerSpan = last - first
  if (footerSpan <= 0) return []

  return metadata.toc
    .filter((item) => item.positionId !== undefined)
    .map((item) => {
      const ratio = (item.positionId - startPosition) / span
      return {
        label: item.label,
        depth: item.depth,
        at: Math.round(first + Math.max(0, Math.min(1, ratio)) * footerSpan)
      }
    })
    .reduce<Array<{ label: string; depth: number; at: number }>>(
      (kept, anchor) => {
        // Compare against the last *kept* anchor. Filtering against the raw
        // array lets a non-monotonic dip through: [10, 8, 9] keeps 10 and 9,
        // which makes one chapter empty and duplicates a page into another.
        const previous = kept.at(-1)
        if (!previous || anchor.at > previous.at) kept.push(anchor)
        return kept
      },
      []
    )
}

/**
 * The chapter heading is printed on the page itself and again by the reader's
 * running head, so a chapter text often starts with its own title two or three
 * times. The export renders the title separately, so drop the repetitions.
 */
function stripLeadingHeading(text: string, label: string): string {
  const needle = label.trim().toLowerCase()
  if (!needle) return text

  let rest = text.trimStart()

  // At most two repetitions: the page itself plus the running head. Allowing
  // more would start eating prose that legitimately opens with its own title —
  // a one-word chapter opening, or a numeric line under a numbered chapter.
  for (let i = 0; i < 2; ++i) {
    const line = rest.split('\n', 1)[0]!.trim()
    if (line.toLowerCase() !== needle) break
    rest = rest.slice(rest.indexOf('\n') + 1).trimStart()
    if (!rest.includes('\n')) break
  }

  return rest
}

/** Joins page texts, keeping paragraph breaks but healing hyphenated words. */
function joinPages(chunks: ContentChunk[]): string {
  return chunks
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .replaceAll(/(\w)-\n\n(\w)/g, '$1$2')
}
