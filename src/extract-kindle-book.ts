import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { SetRequired } from 'type-fest'
import { input } from '@inquirer/prompts'
import delay from 'delay'
import * as OTPAuth from 'otpauth'
import pRace from 'p-race'
// import { chromium } from 'playwright'
import { chromium } from 'patchright'
import sharp from 'sharp'

import type {
  AmazonBookMeta,
  AmazonRenderLocationMap,
  AmazonRenderToc,
  AmazonRenderTocItem,
  BookMetadata,
  TocItem
} from './types'
import { parsePageNav, parseTocItems } from './playwright-utils'
import {
  assert,
  extractTar,
  getEnv,
  hashObject,
  normalizeAuthors,
  normalizeBookMetadata,
  parseAsins,
  parseJsonpResponse,
  tryReadJsonFile
} from './utils'

// Block amazon analytics requests
// (not strictly necessary, but adblockers do this by default anyway and it
// makes the script run a bit faster)
const urlRegexBlacklist = [
  /unagi-\w+\.amazon\.com/i, // 'unagi-na.amazon.com'
  /m\.media-amazon\.com.*\/showads/i,
  /fls-na\.amazon\.com.*\/remote-weblab-triggers/i
]

type RENDER_METHOD = 'screenshot' | 'blob'
const renderMethod: RENDER_METHOD = 'blob'

async function main(asin: string) {
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  // Optional: if set, 2FA codes are generated locally instead of being typed in.
  const amazonTotpSecret = getEnv('AMAZON_TOTP_SECRET')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')
  const asinL = asin.toLowerCase()

  const outDir = path.join('out', asin)
  const userDataDir = path.join(outDir, 'data')
  const pageScreenshotsDir = path.join(outDir, 'pages')
  const metadataPath = path.join(outDir, 'metadata.json')
  await fs.mkdir(userDataDir, { recursive: true })

  // A previous run may have been aborted midway. Its screenshots are numbered
  // by index, so a shorter re-run would leave stale files behind that no longer
  // belong to any page — clear them before starting over.
  const previous = await tryReadJsonFile<BookMetadata>(metadataPath)
  if (previous?.pages?.length && !previous.complete) {
    console.warn(
      `discarding ${previous.pages.length} pages from an incomplete earlier run of ${asin}`
    )
    await fs.rm(pageScreenshotsDir, { recursive: true, force: true })
  }

  await fs.mkdir(pageScreenshotsDir, { recursive: true })

  const krRendererMainImageSelector = '#kr-renderer .kg-full-page-img img'
  const bookReaderUrl = `https://read.amazon.com/?asin=${asin}`

  const result: SetRequired<Partial<BookMetadata>, 'pages' | 'nav'> = {
    pages: [],
    // locationMap: { locations: [], navigationUnit: [] },
    nav: {
      startPosition: -1,
      endPosition: -1,
      startContentPosition: -1,
      startContentPage: -1,
      endContentPosition: -1,
      endContentPage: -1,
      totalNumPages: -1,
      totalNumContentPages: -1
    }
  }

  const deviceScaleFactor = 2
  // On systems without Google Chrome, point CHROME_EXECUTABLE_PATH at a
  // Chromium-based browser (e.g. /usr/bin/brave-browser) or set CHROME_CHANNEL
  // to 'chromium' / 'msedge'. Defaults to the 'chrome' channel.
  const executablePath = getEnv('CHROME_EXECUTABLE_PATH')
  const channel = getEnv('CHROME_CHANNEL') ?? 'chrome'
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(executablePath ? { executablePath } : { channel }),
    args: [
      // hide chrome's crash restore popup
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      // skip the first-run / welcome tabs and the default-browser prompt
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      // Chromium forks (Brave, ...) otherwise open their own onboarding tabs
      // and reward/wallet prompts on every launch.
      '--disable-features=' +
        [
          // disable chrome's password autosave popups
          'PasswordAutosave',
          // disable chrome's passkey popups
          'WebAuthn',
          // disable chrome creating 1GB temp directories on each run
          'MacAppCodeSignClone',
          'Translate',
          'BraveRewards',
          'BraveWallet',
          'BraveVPN',
          'BraveNews'
        ].join(',')
    ],
    ignoreDefaultArgs: [
      // disable chrome's default automation detection flag
      '--enable-automation',
      // adding this cause chrome shows a weird admin popup without it
      '--no-sandbox',
      // adding this cause chrome shows a weird admin popup without it
      '--disable-blink-features=AutomationControlled'
    ],
    // bypass amazon's default content security policy which allows us to inject
    // our own scripts into the page
    bypassCSP: true,
    deviceScaleFactor,
    viewport: { width: 1280, height: 720 }
  })

  // Chromium forks like to open onboarding tabs on launch; keep only one.
  for (const strayPage of context.pages().slice(1)) {
    await strayPage.close().catch(() => {})
  }

  const page = context.pages()[0] ?? (await context.newPage())

  // The reader's metadata (YJmetadata.jsonp, startReading) only arrives once
  // per cold load. With a warm cache — e.g. because the book was already open
  // in this persistent profile — those requests never hit the network and we
  // would never see the responses. Disable the HTTP cache for this page.
  await context
    .newCDPSession(page)
    .then((client) =>
      client.send('Network.setCacheDisabled', { cacheDisabled: true })
    )
    .catch(() => {})

  // Close any tab the browser opens later on (update notes, welcome pages)
  // so the automation always stays on the reader tab.
  context.on('page', async (newPage) => {
    if (newPage === page) return
    await delay(500)
    if (!newPage.url().includes('read.amazon.')) {
      await newPage.close().catch(() => {})
    }
  })

  await page.route('**/*', async (route) => {
    const urlString = route.request().url()
    for (const regex of urlRegexBlacklist) {
      if (regex.test(urlString)) {
        return route.abort()
      }
    }

    return route.continue()
  })

  page.on('response', async (response) => {
    try {
      const status = response.status()
      if (status !== 200) {
        return
      }

      const url = new URL(response.url())

      // DEBUG_REQUESTS=1 lists every Amazon response the reader makes, which is
      // how you find out where the metadata moved to when Amazon changes its
      // endpoints.
      if (getEnv('DEBUG_REQUESTS') && /amazon\./.test(url.hostname)) {
        console.log(
          `[req] ${url.hostname}${url.pathname}${url.search.slice(0, 120)}`
        )

        // DEBUG_REQUESTS=2 also dumps the bodies of the endpoints that could
        // plausibly carry book metadata, so we can find where it moved to.
        if (
          getEnv('DEBUG_REQUESTS') === '2' &&
          /reader-session|\.json$|getFileFromDrive|metadata|startReading|lookup/i.test(
            url.pathname
          )
        ) {
          const body = await response.text().catch(() => '')
          console.log(
            `[body] ${url.pathname} :: ${body.slice(0, 1200).replaceAll(/\s+/g, ' ')}`
          )
        }
      }

      if (url.pathname.endsWith('YJmetadata.jsonp')) {
        const body = await response.text()
        const metadata = parseJsonpResponse<any>(body)
        if (metadata.asin !== asin) return

        delete metadata.cpr
        if (Array.isArray(metadata.authorsList)) {
          metadata.authorsList = normalizeAuthors(metadata.authorsList)
        }

        if (!result.meta) {
          console.warn('book meta', metadata)
          result.meta = metadata
        }
      } else if (
        url.hostname === 'read.amazon.com' &&
        url.searchParams.get('asin')?.toLowerCase() === asinL
      ) {
        if (url.pathname === '/service/mobile/reader/startReading') {
          const body: any = await response.json()
          delete body.karamelToken
          delete body.metadataUrl
          delete body.YJFormatVersion
          if (!result.info) {
            console.warn('book info', body)
          }
          result.info = body
        } else if (url.pathname === '/renderer/render') {
          // TODO: these TAR files have some useful metadata that we could use...
          const params = Object.fromEntries(url.searchParams.entries())
          const hash = hashObject(params)
          const renderDir = path.join(userDataDir, 'render', hash)
          await fs.mkdir(renderDir, { recursive: true })
          const body = await response.body()
          const tempDir = await extractTar(body, { cwd: renderDir })
          const { startingPosition, skipPageCount, numPage } = params
          console.log('RENDER TAR', tempDir, {
            startingPosition,
            skipPageCount,
            numPage
          })

          const locationMap = await tryReadJsonFile<AmazonRenderLocationMap>(
            path.join(renderDir, 'location_map.json')
          )
          if (locationMap) {
            result.locationMap = locationMap

            for (const navUnit of result.locationMap.navigationUnit ?? []) {
              navUnit.page = Number.parseInt(navUnit.label, 10)
              assert(
                !Number.isNaN(navUnit.page),
                `invalid locationMap page number: ${navUnit.label}`
              )
            }
          }

          const metadata = await tryReadJsonFile<any>(
            path.join(renderDir, 'metadata.json')
          )
          if (metadata) {
            result.nav.startPosition = metadata.firstPositionId
            result.nav.endPosition = metadata.lastPositionId

            // Amazon dropped the `YJmetadata.jsonp` endpoint this used to come
            // from, but the same facts ship inside every render TAR: title,
            // authors, language and the start-reading location.
            if (!result.meta && metadata.bookTitle) {
              const meta = {
                asin,
                title: metadata.bookTitle,
                // The render metadata gives a real array of "Last, First"
                // entries; normalizeAuthors only handles the old colon-joined
                // single-string format and would drop all but the first.
                authorList: (metadata.authors ?? []).map((author: string) =>
                  author
                    .split(',')
                    .map((part) => part.trim())
                    .toReversed()
                    .join(' ')
                ),
                language: metadata.lang,
                startPosition: metadata.srl ?? metadata.firstPositionId ?? 0,
                endPosition: metadata.lastPositionId,
                positions: {
                  cover: metadata.coverPosistion ?? 0,
                  srl: metadata.srl,
                  toc: metadata.tocPosition ?? 0
                }
              } as unknown as AmazonBookMeta

              console.warn('book meta (from render metadata)', meta)
              result.meta = meta
            }
          }

          const rawToc = await tryReadJsonFile<AmazonRenderToc>(
            path.join(renderDir, 'toc.json')
          )
          if (rawToc && result.locationMap && !result.toc) {
            const toc: TocItem[] = []

            for (const rawTocItem of rawToc) {
              toc.push(...getTocItems(rawTocItem, { depth: 0 }))
            }

            result.toc = toc
          }

          // TODO: `page_data_0_5.json` has start/end/words for each page in this render batch
          // const toc = JSON.parse(
          //   await fs.readFile(path.join(tempDir, 'toc.json'), 'utf8')
          // )
          // console.warn('toc', toc)
        }
      }
    } catch {}
  })

  // Only used for the 'blob' render method
  const capturedBlobs = new Map<
    string,
    {
      type: string
      base64: string
    }
  >()

  if (renderMethod === 'blob') {
    await page.exposeFunction('nodeLog', (...args: any[]) => {
      console.error('[page]', ...args)
    })

    await page.exposeBinding('captureBlob', (_source, url, payload) => {
      capturedBlobs.set(url, payload)
    })

    await context.addInitScript(() => {
      const origCreateObjectURL = URL.createObjectURL.bind(URL)
      URL.createObjectURL = function (blob: Blob) {
        // TODO: filter for image/png blobs? since those are the only ones we're using
        // (haven't found this to be an issue in practice)
        const type = blob.type || 'application/octet-stream'
        const url = origCreateObjectURL(blob)
        // nodeLog('createObjectURL', url, type, blob.size)

        // Snapshot blob bytes immediately because kindle's renderer revokes
        // them immediately after they're used.
        ;(async () => {
          const buf = await blob.arrayBuffer()
          // store raw base64 (not data URL) to keep payload small
          let binary = ''
          const bytes = new Uint8Array(buf)
          for (const byte of bytes) {
            // eslint-disable-next-line unicorn/prefer-code-point
            binary += String.fromCharCode(byte)
          }

          const base64 = btoa(binary)

          // @ts-expect-error captureBlob
          captureBlob(url, { type, base64 })
        })()

        return url
      }
    })
  }

  // Try going directly to the book reader page if we're already authenticated.
  // Otherwise wait for the signin page to load.
  await Promise.any([
    page.goto(bookReaderUrl, { timeout: 30_000 }),
    page.waitForURL('**/ap/signin', { timeout: 30_000 })
  ])

  // If we're on the signin page, start the authentication flow.
  if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
    await page.locator('input[type="email"]').fill(amazonEmail)
    await page.locator('input[type="submit"]').click()

    await page.locator('input[type="password"]').fill(amazonPassword)
    // await page.locator('input[type="checkbox"]').click()
    await page.locator('input[type="submit"]').click()

    // Amazon only asks for a 2FA code sometimes. Detect the OTP field itself
    // rather than inferring it from the URL: a successful login lands on the
    // reader page, not on /kindle-library, so a URL check would send us into
    // the OTP branch even when no code was ever requested.
    const otpInput = page.locator('input[type="tel"]').first()
    const needsOtp = await otpInput
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    if (needsOtp) {
      const code = amazonTotpSecret
        ? new OTPAuth.TOTP({
            secret: OTPAuth.Secret.fromBase32(
              amazonTotpSecret.replaceAll(/\s+/g, '').toUpperCase()
            )
          }).generate()
        : await input({
            message: '2-factor auth code?'
          })

      if (code) {
        await otpInput.fill(code)

        // The submit button's markup varies between Amazon's OTP variants;
        // fall back to submitting the field directly.
        const otpSubmit = page
          .locator(
            'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"], ' +
              'input[type="submit"], ' +
              'button[type="submit"]'
          )
          .first()
        await otpSubmit
          .click({ timeout: 15_000 })
          .catch(() => otpInput.press('Enter'))

        await page
          .waitForURL((url) => !/\/ap\//.test(url.pathname), {
            timeout: 60_000
          })
          .catch(() => {})
      }
    }

    if (!page.url().includes(bookReaderUrl)) {
      await page.goto(bookReaderUrl)
    }
  }

  async function updateSettings() {
    console.log('Looking for Reader settings button')
    // Address controls by `item-i-d` / element id rather than by aria-label or
    // visible text: those are localized (a German reader says
    // "Leser-Einstellungen" / "Eine Spalte"), the ids are not.
    const settingsButton = page
      .locator('ion-button[item-i-d="top_menu_reader_settings"]')
      .first()
    await settingsButton.waitFor({ timeout: 30_000 })

    // The top chrome auto-hides; reveal it before clicking.
    await page.locator('#reader-header').hover({ force: true })
    await delay(300)
    await ensureFixedHeaderUI().catch(() => {})

    console.log('Clicking Reader settings')
    await settingsButton.click({ force: true })
    await delay(1500)

    // Change font to Amazon Ember
    // My hypothesis is that this font will be easier for OCR to transcribe...
    // TODO: evaluate different fonts & settings
    console.log('Changing font to Amazon Ember')
    await page
      .locator('#AmazonEmber')
      .click({ timeout: 15_000 })
      .catch(() => console.warn('  ! font switch unavailable; keeping default'))
    await delay(200)

    // Change layout to single column — important for OCR, since a two-column
    // layout makes the reading order ambiguous.
    console.log('Changing to single column layout')
    await page
      .locator('#columns-1')
      .click({ timeout: 15_000 })
      .catch(() =>
        console.warn('  ! single-column switch unavailable; check the layout')
      )
    await delay(200)

    // The footer only reports "page X of Y" while the "page in book" progress
    // option is on. Without it the reader shows "Position X of Y" instead, and
    // the extraction loop has no page numbers to count.
    console.log('Enabling page numbers in the footer')
    const pageInBook = page.locator('#page-in-book-item')
    const pageInBookOn = await pageInBook
      .evaluate((el) => !!(el as unknown as { checked?: boolean }).checked)
      .catch(() => false)
    if (!pageInBookOn) {
      await pageInBook
        .click({ timeout: 15_000 })
        .catch(() =>
          console.warn(
            '  ! could not enable page numbers; the footer may show positions ' +
              'instead of pages, which stops the extraction loop'
          )
        )
      await delay(300)
    }

    console.log('Closing settings')
    await settingsButton.click({ force: true }).catch(() => {})
    await delay(500)
  }

  /**
   * Jumps to a page via the reader menu.
   *
   * Recent versions of the Kindle web reader no longer offer a "go to page"
   * entry in that menu, so this can legitimately fail — callers treat it as
   * best-effort and fall back to whatever page the reader is already on.
   */
  async function goToPage(pageNumber: number) {
    // Short timeouts throughout: current readers no longer offer the menu entry
    // this relies on, so failure is the common case — and with Playwright's 30s
    // default that failure costs minutes of staring at an idle window.
    const t = { timeout: 5000 }

    await page.locator('#reader-header').hover({ force: true, ...t })
    await delay(200)
    // Address the menu by item-i-d; aria-labels are localized.
    await page
      .locator('ion-button[item-i-d="top_menu_navigation_menu"]')
      .click({ force: true, ...t })
    await delay(500)
    await page
      .locator('ion-item[role="listitem"]', {
        hasText: /go to page|gehe zu seite/i
      })
      .click(t)
    await page
      .locator('ion-modal input[placeholder="page number"]')
      .fill(`${pageNumber}`, t)
    await page
      .locator('ion-modal ion-button[item-i-d="go-to-modal-go-button"]')
      .click(t)
    await delay(500)
  }

  async function getPageNav() {
    // Amazon has moved this text around; fall back to the whole footer so a
    // changed inner element does not silently yield "no page number".
    let footerText = await page
      .locator('ion-footer ion-title')
      .first()
      .textContent()
      .catch(() => null)

    if (!parsePageNav(footerText)) {
      footerText =
        (await page
          .locator('ion-footer')
          .first()
          .textContent()
          .catch(() => null)) ?? footerText
    }

    return parsePageNav(footerText)
  }

  /**
   * The reader's footer reports progress either in pages ("Page 3 of 250") or,
   * for books without a print edition, in Kindle positions ("Position 1 of
   * 1765"). Both are a monotonically increasing counter, so the extraction loop
   * works off whichever the book offers.
   */
  async function getProgress(): Promise<
    { unit: 'page' | 'location'; value: number; total: number } | undefined
  > {
    // The footer is briefly empty while a page renders. Retry a few times so a
    // single blank reading does not end the book prematurely.
    for (let attempt = 0; attempt < 8; ++attempt) {
      if (attempt > 0) await delay(500)

      const nav = await getPageNav().catch(() => undefined)
      if (!nav) continue

      if (nav.page !== undefined) {
        return { unit: 'page', value: nav.page, total: nav.total }
      }

      if (nav.location !== undefined) {
        return { unit: 'location', value: nav.location, total: nav.total }
      }
    }
  }

  async function ensureFixedHeaderUI() {
    await page.locator('.top-chrome').evaluate((el) => {
      el.style.transition = 'none'
      el.style.transform = 'none'
    })
  }

  async function dismissPossibleAlert() {
    const $alertNo = page.locator('ion-alert button', {
      hasText: /^(no|nein)$/i
    })
    if (await $alertNo.isVisible()) {
      await $alertNo.click()
    }
  }

  async function writeResultMetadata() {
    return fs.writeFile(
      metadataPath,
      JSON.stringify(normalizeBookMetadata(result), null, 2)
    )
  }

  function getTocItems(
    rawTocItem: AmazonRenderTocItem,
    { depth = 0 }: { depth?: number } = {}
  ): TocItem[] {
    const positionId = rawTocItem.tocPositionId
    const page = getPageForPosition(positionId)

    const tocItem: TocItem = {
      label: rawTocItem.label,
      positionId,
      page,
      depth
    }

    const tocItems: TocItem[] = [tocItem]

    if (rawTocItem.entries) {
      for (const rawTocItemEntry of rawTocItem.entries) {
        tocItems.push(...getTocItems(rawTocItemEntry, { depth: depth + 1 }))
      }
    }

    return tocItems
  }

  function getPageForPosition(position: number): number {
    if (!result.locationMap) return -1

    let resultPage = 1

    // TODO: this is O(n) but we can do better
    for (const { startPosition, page } of result.locationMap.navigationUnit ??
      []) {
      if (startPosition > position) break

      resultPage = page
    }

    return resultPage
  }

  await dismissPossibleAlert()
  await ensureFixedHeaderUI()
  await updateSettings()

  console.log('Waiting for book reader to load...')
  await page
    .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
    .catch(() => {
      console.warn(
        'Main reader content may not have loaded, continuing anyway...'
      )
    })

  // The book metadata arrives through background requests. If the reader
  // restored an already-open book, they may not fire at all — wait for them and
  // reload the page if they never show up.
  // `info` is deliberately not required: the endpoint it came from is gone and
  // nothing downstream reads it.
  const hasBookMetadata = () =>
    !!(result.meta && result.toc?.length && result.locationMap)

  for (let attempt = 0; attempt < 3 && !hasBookMetadata(); ++attempt) {
    if (attempt > 0) {
      console.warn(
        `book metadata still incomplete, reloading the reader (attempt ${attempt}/2)...`
      )
      // A failed reload must not abort the book — we may already have enough on
      // disk, and the next attempt can still succeed.
      await page
        .reload({ waitUntil: 'domcontentloaded' })
        .catch((err: unknown) =>
          console.warn(
            `  ! reload failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      await page
        .waitForSelector(krRendererMainImageSelector, { timeout: 60_000 })
        .catch(() => {})
    }

    const deadline = Date.now() + 20_000
    while (!hasBookMetadata() && Date.now() < deadline) {
      await delay(250)
    }

    // Check the disk before deciding another reload is needed: the packages
    // usually did arrive, just not in the order the response handler wants.
    if (!hasBookMetadata()) {
      await recoverMetadataFromDisk()
    }
  }

  /**
   * The reader sends toc.json and location_map.json in separate render packages
   * and in no guaranteed order; the response handler can only pair them when
   * both have arrived. Whatever arrived is on disk, so read the missing pieces
   * straight from the extracted packages — much cheaper and more reliable than
   * reloading the reader and hoping for a better ordering.
   */
  async function recoverMetadataFromDisk() {
    const renderRoot = path.join(userDataDir, 'render')
    const renderDirs = await fs.readdir(renderRoot).catch(() => [])

    for (const dir of renderDirs) {
      const renderDir = path.join(renderRoot, dir)

      if (!result.locationMap) {
        const locationMap = await tryReadJsonFile<AmazonRenderLocationMap>(
          path.join(renderDir, 'location_map.json')
        )
        if (locationMap) {
          result.locationMap = locationMap
          for (const navUnit of result.locationMap.navigationUnit ?? []) {
            const page = Number.parseInt(navUnit.label, 10)
            if (!Number.isNaN(page)) navUnit.page = page
          }
        }
      }

      if (!result.toc?.length) {
        const rawToc = await tryReadJsonFile<AmazonRenderToc>(
          path.join(renderDir, 'toc.json')
        )
        if (rawToc?.length) {
          result.toc = rawToc.flatMap((item) => getTocItems(item, { depth: 0 }))
        }
      }
    }

    if (hasBookMetadata()) {
      console.warn('recovered book metadata from the extracted render packages')
    }
  }

  if (!hasBookMetadata()) {
    console.warn('missing book metadata:', {
      meta: !!result.meta,
      toc: result.toc?.length ?? 0,
      locationMap: !!result.locationMap
    })
  }

  // Record the initial page navigation so we can reset back to it later
  const initialPageNav = await getPageNav()

  // At this point, we should have recorded all the base book metadata from the
  // initial network requests.
  assert(result.meta, 'expected book meta to be initialized')
  assert(result.toc?.length, 'expected book toc to be initialized')
  assert(result.locationMap, 'expected book location map to be initialized')

  result.nav.startContentPosition = result.meta.startPosition
  result.nav.totalNumPages = (result.locationMap.navigationUnit ?? []).reduce(
    (acc, navUnit) => {
      return Math.max(acc, navUnit.page ?? -1)
    },
    -1
  )
  // Books without a print edition ship an empty navigation unit — they have no
  // page numbers at all and are read by position instead, so this is not fatal.
  const hasPageNumbers = result.nav.totalNumPages > 0
  if (!hasPageNumbers) {
    console.warn(
      'this book has no page navigation; reading it by position instead'
    )
    result.nav.totalNumPages = 0
  }

  result.nav.startContentPage = getPageForPosition(
    result.nav.startContentPosition
  )

  const parsedToc = parseTocItems(result.toc, {
    totalNumPages: result.nav.totalNumPages
  })
  result.nav.endContentPage =
    parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages
  result.nav.endContentPosition =
    parsedToc.firstPostContentPageTocItem?.positionId ?? result.nav.endPosition

  result.nav.totalNumContentPages = Math.min(
    parsedToc.firstPostContentPageTocItem?.page ?? result.nav.totalNumPages,
    result.nav.totalNumPages
  )
  assert(
    !hasPageNumbers || result.nav.totalNumContentPages > 0,
    'No content pages found'
  )

  // Decide up front whether this book reports pages or Kindle positions; the
  // whole extraction loop keys off that.
  const initialProgress = await getProgress()
  const usePositions = !hasPageNumbers || initialProgress?.unit === 'location'
  // Note the footer's position counter runs on its own scale ("Position 1 of
  // 1765"), which is unrelated to the internal position ids in the metadata
  // (0…219369) — so the end marker has to come from the footer as well.
  const endProgressValue = usePositions
    ? (initialProgress?.total ?? Number.MAX_SAFE_INTEGER)
    : result.nav.totalNumContentPages

  const pageNumberPaddingAmount = `${
    (usePositions ? endProgressValue : result.nav.totalNumContentPages) * 2
  }`.length
  await writeResultMetadata()

  // Navigate to the first content page of the book. Best-effort: if the reader
  // has no "go to page" menu entry, carry on from wherever the book is open —
  // open it on the first page manually before starting the script.
  // Skipped for position-based books, where a page number means nothing anyway.
  const skipGoToPage = usePositions || result.nav.startContentPage <= 1
  await (
    skipGoToPage ? Promise.resolve() : goToPage(result.nav.startContentPage)
  ).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(
      `\n! could not jump to page ${result.nav.startContentPage} automatically ` +
        `(${reason}).\n  Continuing from the current page — make sure ` +
        `the book is open at the beginning.\n`
    )
  })

  let done = false
  console.warn(
    usePositions
      ? `\nreading by position up to ${endProgressValue} ` +
          `(this book has no page numbers)...\n`
      : `\nreading ${result.nav.totalNumContentPages} content pages out of ${result.nav.totalNumPages} total pages...\n`
  )

  do {
    const progress = await getProgress()

    if (progress === undefined) {
      console.warn(
        'stopping: the reader footer reports neither a page nor a position'
      )
      break
    }

    if (progress.unit === 'page') {
      if (progress.value > result.nav.totalNumContentPages) {
        console.warn(
          `stopping: reached page ${progress.value} of ${result.nav.totalNumContentPages} content pages`
        )
        break
      }
    } else if (progress.value > endProgressValue) {
      // Position-based books stop at the end of the main content, so the index,
      // ads and "about the author" pages are not exported.
      console.warn(
        `stopping: reached position ${progress.value} of ${endProgressValue}`
      )
      break
    }

    const index = result.pages.length

    const src = (await page
      .locator(krRendererMainImageSelector)
      .getAttribute('src'))!

    let renderedPageImageBuffer: Buffer | undefined

    if (renderMethod === 'blob') {
      const blob = await pRace<{ type: string; base64: string } | undefined>(
        (signal) => [
          (async () => {
            while (!signal.aborted) {
              const blob = capturedBlobs.get(src)

              if (blob) {
                capturedBlobs.delete(src)
                return blob
              }

              await delay(1)
            }
          })(),

          delay(10_000, { signal })
        ]
      )

      assert(
        blob,
        `no blob found for src: ${src} (index ${index}; ${progress.unit} ${progress.value})`
      )

      const rawRenderedImage = Buffer.from(blob.base64, 'base64')
      const c = sharp(rawRenderedImage)
      const m = await c.metadata()
      renderedPageImageBuffer = await c
        .resize({
          width: Math.floor(m.width / deviceScaleFactor),
          height: Math.floor(m.height / deviceScaleFactor)
        })
        .png({ quality: 90 })
        .toBuffer()
    } else {
      renderedPageImageBuffer = await page
        .locator(krRendererMainImageSelector)
        .screenshot({ type: 'png', scale: 'css' })
    }

    assert(
      renderedPageImageBuffer,
      `no buffer found for src: ${src} (index ${index}; ${progress.unit} ${progress.value})`
    )

    const screenshotPath = path.join(
      pageScreenshotsDir,
      `${index}`.padStart(pageNumberPaddingAmount, '0') +
        '-' +
        `${progress.value}`.padStart(pageNumberPaddingAmount, '0') +
        '.png'
    )

    await fs.writeFile(screenshotPath, renderedPageImageBuffer)
    const pageChunk = {
      index,
      // For position-based books this carries the Kindle position rather than a
      // page number; `unit` records which one it is.
      page: progress.value,
      unit: progress.unit,
      screenshot: screenshotPath
    }
    result.pages.push(pageChunk)
    console.warn(pageChunk)
    await writeResultMetadata()

    // The last page has no "next page" control. Recognising that here ends the
    // book cleanly, instead of spending 30 failing click attempts (~2.5 min) on
    // a button that cannot appear — during which the browser sometimes dies and
    // takes the whole extraction down with it, losing the completion marker.
    // Ask the reader itself whether another page exists. Comparing the footer's
    // counters does not work: a position-based book ends on the page that
    // *starts* at e.g. 4397 of 4404, so the numbers never meet and the loop
    // would fall through to 30 failing click attempts (~2.5 min per book).
    const hasNextPage = await page
      .locator('.kr-chevron-container-right')
      .isVisible()
      .catch(() => false)

    if (!hasNextPage || progress.value >= progress.total) {
      console.warn(
        `reached the end of the book (${progress.unit} ${progress.value} of ${progress.total})`
      )
      done = true
      continue
    }

    let retries = 0

    do {
      // This delay seems to help speed up the navigation process, possibly due
      // to the navigation chevron needing time to settle.
      await delay(100)

      let navigationTimeout = 10_000
      try {
        // await page.keyboard.press('ArrowRight')
        await page
          .locator('.kr-chevron-container-right')
          .click({ timeout: 5000 })
      } catch (err: any) {
        console.warn('unable to click next page button', err.message, progress)
        navigationTimeout = 1000
      }

      const navigatedToNextPage = await pRace<boolean | undefined>((signal) => [
        (async () => {
          while (!signal.aborted) {
            const newSrc = await page
              .locator(krRendererMainImageSelector)
              .getAttribute('src')

            if (newSrc && newSrc !== src) {
              // Successfully navigated to the next page
              return true
            }

            await delay(10)
          }

          return false
        })(),

        delay(navigationTimeout, { signal })
      ])

      if (navigatedToNextPage) {
        break
      }

      if (++retries >= 5) {
        console.warn('unable to navigate to next page; breaking...', progress)
        done = true
        break
      }
    } while (true)
  } while (!done)

  // Only a run that actually reached the end of the book counts as complete.
  // `done` is set when the last page was seen or navigation ran out; every
  // other exit (an empty footer, missing progress) leaves the export partial,
  // and marking those finished would silently skip them on the next run.
  result.complete = done && result.pages.length > 0
  if (!result.complete) {
    console.warn(
      `\n! ${asin} ended early with ${result.pages.length} pages — not marking it complete`
    )
  }
  await writeResultMetadata()
  console.log()
  console.log(metadataPath)

  if (initialPageNav?.page !== undefined) {
    console.warn(`resetting back to initial page ${initialPageNav.page}...`)
    // Reset back to the initial page (best-effort, see goToPage)
    await goToPage(initialPageNav.page).catch(() => {})
  }

  // Closing a persistent context occasionally hangs; a stuck window must not
  // block the remaining books.
  await pRace<void>((signal) => [
    (async () => {
      await context.close()
      await context.browser()?.close()
    })(),
    delay(20_000, { signal })
  ]).catch(() => {})
}

const asins = parseAsins(getEnv('ASIN'))
assert(
  asins.length,
  'ASIN is required (single value, comma-separated list or JSON array)'
)

if (asins.length > 1) {
  console.log(`extracting ${asins.length} books: ${asins.join(', ')}\n`)
}

let failures = 0

/**
 * A book counts as done when its metadata lists pages and every screenshot it
 * names is on disk. Lets a long multi-book run be resumed after an abort
 * without re-doing the books that already finished.
 */
async function isAlreadyExtracted(asin: string): Promise<boolean> {
  const metadata = await tryReadJsonFile<BookMetadata>(
    path.join('out', asin, 'metadata.json')
  )
  if (!metadata?.pages?.length || !metadata.complete) return false

  const missing = await Promise.all(
    metadata.pages.map((p) =>
      fs
        .access(p.screenshot)
        .then(() => false)
        .catch(() => true)
    )
  )

  return !missing.includes(true)
}

for (const [i, asin] of asins.entries()) {
  if (asins.length > 1) {
    console.log(`\n===== [${i + 1}/${asins.length}] ${asin} =====\n`)
  }

  try {
    if (!getEnv('FORCE_REEXTRACT') && (await isAlreadyExtracted(asin))) {
      console.log(
        `${asin} already extracted, skipping (FORCE_REEXTRACT=1 to redo)`
      )
      continue
    }

    await main(asin)

    // Give Amazon a breather between books.
    if (i < asins.length - 1) await delay(5000)
  } catch (err) {
    // One unavailable or unsupported book must not abandon the rest of the list.
    ++failures
    console.error(`\n!! failed to extract ${asin}:`, err)
  }
}

if (failures) {
  throw new Error(`${failures} of ${asins.length} book(s) failed`)
}
