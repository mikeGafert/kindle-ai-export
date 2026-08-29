import 'dotenv/config'

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import PDFDocument from 'pdfkit'

import type { BookMetadata, ContentChunk } from './types'
import { getChapters } from './book-structure'
import { assert, getEnv, parseAsins } from './utils'

export async function exportPdf(asin: string): Promise<string> {
  const outDir = path.join('out', asin)

  const content = JSON.parse(
    await fsp.readFile(path.join(outDir, 'content.json'), 'utf8')
  ) as ContentChunk[]
  const metadata = JSON.parse(
    await fsp.readFile(path.join(outDir, 'metadata.json'), 'utf8')
  ) as BookMetadata
  assert(content.length, `${asin}: no book content found`)
  assert(metadata.meta, `${asin}: invalid book metadata: missing meta`)

  const title = metadata.meta.title
  const authors = metadata.meta.authorList

  const doc = new PDFDocument({
    autoFirstPage: true,
    displayTitle: true,
    info: {
      Title: title,
      Author: authors.join(', ')
    }
  })
  const pdfPath = path.join(outDir, 'book.pdf')
  const stream = doc.pipe(fs.createWriteStream(pdfPath))

  const fontSize = 12

  const renderTitlePage = () => {
    ;(doc as any).outline.addItem('Title Page')
    doc.fontSize(48)
    doc.y = doc.page.height / 2 - doc.heightOfString(title) / 2
    doc.text(title, { align: 'center' })
    const w = doc.widthOfString(title)

    const byline = `By ${authors.join(',\n')}`

    doc.fontSize(20)
    doc.y -= doc.heightOfString(byline) / 2
    doc.text(byline, {
      align: 'center',
      indent: w - doc.widthOfString(byline)
    })

    doc.addPage()
    doc.fontSize(fontSize)
  }

  renderTitlePage()

  const chapters = getChapters(metadata, content)
  assert(chapters.length, `${asin}: could not split the book into chapters`)

  let needsNewPage = false

  for (const chapter of chapters) {
    if (needsNewPage) doc.addPage()
    ;(doc as any).outline.addItem(chapter.label)
    doc.fontSize(chapter.depth === 1 ? 16 : 20)
    doc.text(chapter.label, { align: 'center', lineGap: 16 })

    doc.fontSize(fontSize)
    doc.moveDown(1)
    doc.text(chapter.text, { indent: 20, lineGap: 4, paragraphGap: 8 })

    needsNewPage = true
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })

  return pdfPath
}

// Allow running this file on its own.
if (path.basename(process.argv[1] ?? '').startsWith('export-book-pdf')) {
  const asins = parseAsins(getEnv('ASIN'))
  assert(asins.length, 'ASIN is required')

  for (const asin of asins) {
    console.log(`${asin} -> ${await exportPdf(asin)}`)
  }
}
