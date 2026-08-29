# Kindle AI Export <!-- omit from toc -->

> **Fork-Hinweis.** Dies ist Mikes Fork von
> [transitive-bullshit/kindle-ai-export](https://github.com/transitive-bullshit/kindle-ai-export)
> (MIT, Travis Fischer). Angepasst für den heutigen Kindle-Web-Reader und eine
> deutschsprachige Oberfläche:
>
> - Metadaten aus den `render`-Paketen, da Amazon `startReading` und
>   `YJmetadata.jsonp` abgeschafft hat
> - sprachneutrale Selektoren (`item-i-d`/Element-IDs statt englischer Beschriftungen)
> - Bücher ohne Seitenzahlen werden über Kindle-Positionen gelesen
> - mehrere ASINs pro Lauf, Wiederaufnahme über einen `complete`-Marker
> - Transkription über **Mistral OCR** im Batch-Modus statt eines Vision-LLM
>   (`src/transcribe-book-content-claude.ts` behält die LLM-Variante)
> - Browser frei wählbar (`CHROME_EXECUTABLE_PATH`), 2FA per `AMAZON_TOTP_SECRET`

> Export any Kindle book you own as text, PDF, EPUB, or as a custom, AI-narrated audiobook. 🔥

<p>
  <a href="https://github.com/transitive-bullshit/kindle-ai-export/actions/workflows/main.yml"><img alt="Build Status" src="https://github.com/transitive-bullshit/kindle-ai-export/actions/workflows/main.yml/badge.svg" /></a>
  <a href="https://github.com/transitive-bullshit/kindle-ai-export/blob/main/license"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <a href="https://prettier.io"><img alt="Prettier Code Formatting" src="https://img.shields.io/badge/code_style-prettier-brightgreen.svg" /></a>
</p>

- [Intro](#intro)
  - [How does it work?](#how-does-it-work)
  - [Audiobook Examples 🔥](#audiobook-examples-)
  - [Why is this necessary?](#why-is-this-necessary)
- [Usage](#usage)
  - [Setup Env Vars](#setup-env-vars)
  - [Extract Kindle Book](#extract-kindle-book)
  - [Transcribe Book Content](#transcribe-book-content)
  - [(Optional) Export Book as PDF](#optional-export-book-as-pdf)
  - [(Optional) Export Book as EPUB](#optional-export-book-as-epub)
  - [(Optional) Export Book as Markdown](#optional-export-book-as-markdown)
  - [(Optional) Export Book as AI-Narrated Audiobook 🔥](#optional-export-book-as-ai-narrated-audiobook-)
- [Disclaimer](#disclaimer)
- [Author's Notes](#authors-notes)
  - [Alternative Approaches](#alternative-approaches)
  - [How is the accuracy?](#how-is-the-accuracy)
- [License](#license)

## Intro

This project makes it easy to export the contents of any ebook in your Kindle library as text, PDF, EPUB, or as a custom, AI-narrated audiobook. It only requires a valid Amazon Kindle account and a Mistral API key.

_You must own the ebook on Kindle for this project to work._

### How does it work?

It works by logging into your [Kindle web reader](https://read.amazon.com) account using [Playwright](https://playwright.dev), exporting each page of a book as a PNG image, and then running OCR over each page (Mistral OCR) to turn it into text. Once we have the raw book contents and metadata, then it's easy to convert it to PDF, EPUB, etc. 🔥

This [example](./examples/B0819W19WD) uses the first page of the scifi book [Revelation Space](https://www.amazon.com/gp/product/B0819W19WD?ref_=dbs_m_mng_rwt_calw_tkin_0&storeType=ebooks) by [Alastair Reynolds](https://www.goodreads.com/author/show/51204.Alastair_Reynolds):

<table>
  <tbody>
    <tr>
      <td>
        The automated script starts from the Kindle web reader's library page and selects the book we want to export.
      </td>
      <td>
        <img src="./examples/B0819W19WD/kindle-reader-library-example.jpg" alt="Kindle web reader library">
      </td>
    </tr>
    <tr>
      <td>
        We use Playwright to navigate to each page of the selected book.
      </td>
      <td>
        <img src="./examples/B0819W19WD/kindle-reader-page-example.png" alt="Kindle web reader page">
      </td>
    </tr>
    <tr>
      <td>
        For each page, we use Playwright to export a scaled down PNG screenshot of the page's rendered content.
      </td>
      <td>
        <img src="./examples/B0819W19WD/pages/0000-0001.png" alt="First page of Revelation Space by Alastair Reynolds">
      </td>
    </tr>
    <tr>
      <td>
        We then convert each page's screenshot into text with Mistral OCR.
      </td>
      <td>
        <p>Mantell Sector, North Nekhebet, Resurgam, Delta Pavonis system, 2551</p>
        <p>There was a razorstorm coming in.</p>
        <p>Sylveste stood on the edge of the excavation and wondered if any of his labours would survive the night. The archaeological dig was an array of deep square shafts separated by baulks of sheer-sided soil: the classical Wheeler box-grid. The shafts went down tens of metres, walled by transparent cofferdams spun from hyperdiamond. A million years of stratified geological history pressed against the sheets. But it would take only one good dustfall—one good razorstorm—to fill the shafts almost to the surface.</p>
        <p>“Confirmation, sir,” said one of his team, emerging from the crouched form of the first crawler. The man’s voice was muffled behind his breather mask. “Cuvier’s just issued a severe weather advisory for the whole North</p>
      </td>
    </tr>
    <tr>
      <td>
        After doing this for each page, we now have access to the book's full contents and metadata, so we can export it in any format we want. 🎉
      </td>
      <td>
        <p>Here are some output previews containing only the first page of this book:</p>
        <ul>
          <li>
            <a href="./examples/B0819W19WD/book-preview.pdf">PDF output preview</a>
          </li>
          <li>
            <a href="./examples/B0819W19WD/book-preview.epub">EPUB output preview</a>
          </li>
          <li>
            <a href="./examples/B0819W19WD/book-preview.md">Markdown output preview</a>
          </li>
          <li>
            <a href="#audiobook-examples-">Audiobook examples</a>
          </li>
        </ul>
      </td>
    </tr>
  </tbody>
</table>

### Audiobook Examples 🔥

We can even use TTS to generate custom audiobooks.

Here are some auto-generated examples using a few different TTS providers & voices, containing only the first page of this book as a preview:

<table>
  <tbody>
    <tr>
      <td align="center">
        OpenAI tts-1-hd "alloy" voice <br />(female; solid quality but more expensive)
      </td>
      <td>
        <video src="https://github.com/user-attachments/assets/f634f2cc-cc65-4381-ba04-5fc59df69668"></video>
      </td>
    </tr>
    <tr>
      <td align="center">
        OpenAI tts-1-hd "onyx" voice <br />(male; solid quality but more expensive)
      </td>
      <td>
        <video src="https://github.com/user-attachments/assets/5cc86ae3-9f82-414c-a69f-a2ab40db4ce1"></video>
      </td>
    </tr>
    <tr>
      <td align="center">
        Unreal Speech "Scarlett" voice <br />(female; medium quality but cheaper)
      </td>
      <td>
        <video src="https://github.com/user-attachments/assets/232e5258-9f89-4493-a06b-5523ddf93226"></video>
      </td>
    </tr>
  </tbody>
</table>

### Why is this necessary?

**Kindle uses a [custom AZW3 format](https://en.wikipedia.org/wiki/Kindle_File_Format) which includes heavy DRM**, making it very difficult to access the contents of ebooks that you own. It is possible to [strip the DRM using existing tools](#alternative-approaches), but it's a serious pain in the ass, is very difficult to automate, and the "best" solution is expensive and not open source.

This project changes that.

_Why?_ Because I love reading books on Kindle (especially scifi books!!), but none of the content is _hackable_. The official Kindle apps are also lagging behind in their AI features, so my goal with this project was to make it easy to build AI-powered experiments on top of my own Kindle library. In order to do that, I first needed a reliable way to export the contents of my Kindle books in a reasonable format.

I also created an [OSS TypeScript client for the unofficial Kindle API](https://github.com/transitive-bullshit/kindle-api), but I ended up only using some of the types and utils since Playwright + vLLMs allowed me to completely bypass their API and DRM. This approach should also be a lot less error-prone than using their unofficial API.

## Usage

### Requirements

- **Node.js 20+** and **pnpm** (`corepack enable && corepack prepare pnpm@10.18.3 --activate`)
- **Google Chrome** (or another Chromium build). The reader is driven in a
  _visible_ browser window, so you need a desktop session — this does not run
  headless on a server without `Xvfb`.
- A **Mistral API key** with billing enabled — https://console.mistral.ai.
  Batch jobs must be unlocked separately there; without that the run falls back
  to single requests at twice the price per page.
- You must **own** the books on Kindle.

```sh
pnpm install
npx patchright install chrome   # skip if Chrome is already installed
```

### The whole thing in one command

```sh
pnpm start
```

On the first run it asks for whatever is missing — Amazon login, ASINs, the
Mistral key — and stores it in `.env` (mode 600, git-ignored). Passwords and
keys are masked while typing. Then it runs all three steps in order:

1. **extract** — opens each book in the reader and captures every page as an image
2. **transcribe** — OCR through Mistral, producing `content.json`
3. **finalize** — builds EPUB and PDF, verifies them, then deletes the working files

Each step can also be run on its own (`pnpm extract`, `pnpm transcribe`,
`pnpm finalize`) and each of them skips books that are already done, so an
interrupted run is resumed by simply starting it again.

### Where things end up

Two directories, deliberately separate:

|              | Contents                                                 | Default                             |
| ------------ | -------------------------------------------------------- | ----------------------------------- |
| `OUTPUT_DIR` | `book.epub`, `book.pdf`, `content.json`, `metadata.json` | `<documents>/Kindle-Export/<ASIN>/` |
| `WORK_DIR`   | page images, browser profile — hundreds of MB per book   | platform app-data directory         |

The working files are kept out of the documents folder on purpose: it is often
cloud-synced, and a browser profile has no business being replicated to every
device. Both can be set in `.env`. They must not overlap — finalizing deletes
the working directory, which would otherwise take the finished book with it.

### Finding an ASIN

Open the book in https://read.amazon.com and read it from the address bar:
`read.amazon.com/?asin=B07QLY87NH`. Several books at once:

```sh
ASIN=B07QLY87NH,B00957T6X6
```

### Optional settings

| Variable                                 | Effect                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `MISTRAL_OCR_MODEL`                      | OCR model, default `mistral-ocr-3`                                                          |
| `MISTRAL_MODE`                           | `auto` (default), `batch` or `sync`                                                         |
| `MISTRAL_CONCURRENCY`                    | parallel requests in sync mode, default 5                                                   |
| `TRANSCRIBE_LIMIT`                       | only transcribe the first N pages — a cheap trial                                           |
| `AMAZON_TOTP_SECRET`                     | 2FA secret; without it you are asked for the code                                           |
| `CHROME_EXECUTABLE_PATH`                 | path to a browser if Chrome is not installed                                                |
| `PDF_FONT`                               | `.ttf` for the PDF; without a Unicode font, characters outside Western European are dropped |
| `KEEP_PAGES`                             | keep the page images instead of deleting them                                               |
| `FORCE_REEXTRACT` / `FORCE_RETRANSCRIBE` | redo a book that is already done                                                            |
| `MAX_MISSING_PAGES`                      | how many pages may be missing before a book counts as unfinished (default 5)                |

### Audiobooks

`src/export-book-audio.ts` is inherited from upstream and still uses OpenAI or
UnrealSpeech for text-to-speech. It is not part of `pnpm start`: text-to-speech
is billed per character, so a shelf of books costs orders of magnitude more than
the OCR, and it would read every OCR error aloud. Needs `ffmpeg` on the PATH.

## Disclaimer

**This project is intended purely for personal and educational use only**. It is not endorsed or supported by Amazon / Kindle. By using this project, you agree to not hold the author or contributors responsible for any consequences resulting from its usage.

## Author's Notes

This project will only work on Kindle books which you have access to in your personal library. **Please do not share the resulting exports publicly** – _we need to make sure that our authors and artists get paid fairly for their work_!

With that being said, I also feel strongly that we should individually be able to use content that we own in whatever format best suits our personal needs, especially if that involves building cool, open source experiments for LLM-powered book augmentation, realtime narration, and other unique AI-powered UX ideas.

I expect that Amazon Kindle will eventually get around to supporting some modern LLM-based features at some point in the future, but [ain't nobody got time to wait around for that](https://youtu.be/waEC-8GFTP4?t=25).

### Alternative Approaches

If you want to explore other ways of exporting your personal ebooks from Kindle, [this article](https://www.digitaltrends.com/mobile/how-to-convert-kindle-to-pdf/) gives a great breakdown of the options available, including [Calibre](https://calibre-ebook.com) (FOSS) and [Epubor Ultimate](https://www.epubor.com/ultimate.html) (paid). Trying to use the most popular [free online converter](https://cloudconvert.com/azw3-to-pdf) will throw a DRM error.

Compared with these approaches, the approach used by this project is much easier to automate. It also retains metadata about Kindle's original sync positions which is very useful for cases where you'd like to interoperate with Kindle. E.g., be able to jump from reading a Kindle book to listening to an AI-generated narration on a walk and then jumping back to reading the Kindle book and having the sync positions "just work".

The `image ⇒ text` step is OCR, not a language model reading the page. That
distinction matters: a language model _understands_ what it reads and will
occasionally smooth or invent text — in testing, one produced a chapter heading
that was not on the page at all, twice in a row and differently each time. An
OCR engine only recognises glyphs, so its mistakes look like mistakes.

What it does get wrong is elaborate display typography: a decorated title page
may come out as `65 war einmal` instead of `Es war einmal`. Body text in a
normal typeface is transcribed faithfully, including old spellings and
typographic quotation marks, which a language model tends to "correct".

Cost is no longer a real factor: Mistral OCR in batch mode runs at roughly one
US dollar per 1000 pages, so a shelf of 22 books — about 15,000 pages — comes to
around $15. `src/transcribe-book-content-claude.ts` keeps the original
vision-model route for comparison; it costs about seven times as much.

### How is the accuracy?

The accuracy / fidelity has been very close to perfect in my testing, with the only discrepancies being occasional whitespace issues.

I'm sure there will be edge cases and ebook features that are missing (like embedded images), but it shouldn't be too hard to add those if there's enough interest.

## License

MIT © [Travis Fischer](https://x.com/transitive_bs)

If you found this project interesting, [consider following me on Twitter](https://x.com/transitive_bs).
