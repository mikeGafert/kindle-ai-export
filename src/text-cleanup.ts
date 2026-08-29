/**
 * Post-processing for OCR output, kept separate from the transcription
 * script so it can be tested without an API key.
 */

/**
 * Mistral returns structured Markdown. For a plain-text book export the markup
 * is noise, so strip what the OCR added while leaving the words untouched.
 */
export function stripMarkdown(text: string): string {
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
