# Mountain

Read English e-books and understand every word. Tap any word for an instant
Kazakh translation plus a real explanation — pronunciation, part of speech,
English definitions, and an example. Select a phrase or sentence to translate
the whole thing.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
```

Node 24 is required. On first run, the app creates the gitignored `data/`
directory and its local SQLite database automatically. No database setup or
API key is needed for local use.

For a production run:

```bash
npm run build
npm start
```

The production build uses Next.js's supported Webpack option. This also works
in environments where Turbopack's CSS worker cannot open a local port.

There is no signup. Locally, books, vocabulary, sessions, translation cache,
and uploaded file bytes live in `data/reader.db`. In deployment, set
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use a Turso/libSQL database;
the app does not rely on persistent server disk. The health route returns 503
when the database or a required module is unavailable.

```bash
npm test
```

Node's own test runner, no test framework and no new dependencies — the source
is TypeScript that Node strips types from directly. The tests cover the parts
that fail silently rather than loudly: what the article extractor does with
malformed markup, what `safe-fetch.ts` refuses, and what happens to accounts
when two requests race or a claim is redeemed twice. Those last ones run
against a real SQLite file in a temporary directory, because what is being
tested is what the database does — a primary key settling a race, a transaction
refusing to spend a code twice, a migration reshaping a table that already has
rows in it. `src/lib/db-migration.test.ts` opens a database written by the
previous schema and checks that nobody is signed out by the upgrade.

Each browser gets its own library. On first visit a random token goes into a
cookie and an account is opened behind it — nothing to fill in, and every book,
saved word and streak belongs to that account from then on.

**Reading on a second device.** At the bottom of the library page, *Show a
code* prints something like `4GPK-M44S-YMTF`. Type it into the same place on
the other device, under *Already have a code?*, and that device is signed in to
the same account: both stay signed in, and anything the second device had
already saved is folded in rather than left behind. The code lasts ten minutes,
works once, and asking for a new one cancels the old. There is still no
password to lose — but clearing the cookie on every device you own does mean
starting over.

Upgrading a database from before accounts existed: the migration runs
automatically at startup, parks the whole existing library in an account nobody
holds yet, and prints a one-time claim link to the server log:

```
/claim?code=7342bce6…
```

Open that once in the browser you read in and the library is yours. That code
never expires, because there is no moment at which a line in a log file can be
assumed to have been read; every other code does. Both are spent on use and
stored nowhere else, so nothing can inherit your books by simply being the
first request to arrive — which is what a health check or a crawler would
otherwise do.

Upgrading from a deployment that predates second devices needs nothing: the
token each browser is holding is moved into the new `sessions` table on the
first request after the deploy, and nobody is signed out.

## What it does

**Getting books in**
- On an empty library, choose **Read the sample** to open a short original
  two-chapter story immediately. It stays in your own library and needs no
  catalog request.
- Drag an **EPUB, PDF, TXT, or subtitle file (SRT/VTT)** onto the library page
  (4 MB limit — the platform refuses a larger request body before the app sees
  it, so the app refuses it first and says why). Subtitles are re-flowed from
  screen-sized cues back into paragraphs, so a transcript reads like prose.
- Paste **a link to any article** and the readable text is pulled out of the
  page and stored like any other book.
- Or open **Browse** and pull public-domain titles straight from Project
  Gutenberg — search, pick one, and it opens in the reader.
- Every book can be downloaded again from the library or the reader's `⤓`
  button. Uploads give you back the exact file you put in.

**Reading**
- Every word is its own tap target. Tapping opens a card with the translation,
  IPA pronunciation, a 🔊 button (browser speech synthesis), dictionary senses,
  usage examples, synonyms, and how many times the word occurs in this book.
- The first English definition is also translated, so you are never stuck
  reading an explanation in the language you are still learning.
- The card offers **"Translate the whole sentence"** for the sentence the word
  sits in, and highlighting any passage translates that passage directly.
- **Read aloud** (`▶`) speaks the chapter with the current word highlighted,
  scrolling to keep up. Speed is adjustable and remembered.
- **Search inside the book** (`⌕` or `⌘F`) over a SQLite FTS5 index; a result
  jumps to the chapter and flashes the word.
- Light / sepia / dark themes, adjustable text size, line spacing, column
  width, and serif/sans. Settings persist in `localStorage`.
- Reading position is saved per book automatically; the library shows a
  progress bar and where you left off. `←` / `→` move between chapters.

**Knowing which words you know**
- Mark a word **"I know it"** and it fades into the background of the text —
  still readable, no longer competing for attention.
- Every book is counted by lemma at import, so the library can tell you
  **"74% known words"** per book. Above ~95% a book reads smoothly; below ~90%
  it is a slog. That number is the fastest way to pick the right next book.
- Each book also offers its **commonest words you don't know yet** — the
  highest-value twenty words to learn before starting it.
- Start from the built-in common-word list on the **Progress** page instead of
  from zero.

**Learning**
- "Save to vocabulary" stores the word with its translation and the sentence
  you met it in. Saved words stay underlined in the text.
- One saved word becomes up to **three cards**, each scheduled separately:
  *recognise* (English → your language), *produce* (the harder direction, where
  recall is actually built), and *cloze* — the sentence you met the word in
  with the word blanked out.
- Five Leitner boxes: a miss returns the card in 10 minutes, and correct
  answers push it out to 1, 3, 7, then 21 days. A card that survives the top
  box graduates into your known words and starts counting towards coverage.
- **Export** the whole vocabulary as tab-separated text Anki imports directly,
  or as CSV.

**Progress**
- Streak, time actually spent reading (counted only while the tab is visible),
  words read, review accuracy, and a twelve-week activity calendar.

**Appearance**
- The app starts in light mode. The `◐` button in the nav cycles
  light → dark → system and pins your choice; an inline script in the layout
  applies it during HTML parsing, so a pinned theme never flashes the wrong
  one on load.
- The reader's paper (light / sepia / dark) is chosen separately in its own
  settings — what reads well behind a page of prose is not what reads well
  behind a library.

**Offline**
- Installable as a PWA. Chapters you have already opened, and your known-word
  list, are cached — a book you were reading stays readable with no connection.
  Writes and translation still need the network, and say so rather than
  silently returning something stale.

## How it is put together

Next.js 16 (App Router) + TypeScript + Tailwind v4, with SQLite through
`@libsql/client`. It opens a local file in development and uses Turso/libSQL
over the network when `TURSO_DATABASE_URL` is set. The same schema and queries
serve both, including the FTS5 search index. Uploaded file bytes are stored in
the `book_files` table alongside their parsed chapters.

| Path | Role |
| --- | --- |
| `src/lib/db.ts` | Schema and migrations, run once on first import |
| `src/lib/accounts.ts` | Accounts, sessions, link codes — no request state |
| `src/lib/session.ts` | Reads the session cookie and hands it to `accounts.ts` |
| `src/lib/safe-fetch.ts` | Fetching an address the reader chose, without reaching the private network |
| `src/lib/ingest.ts` | EPUB (JSZip + OPF spine), PDF (pdfjs), TXT and SRT/VTT → chapters |
| `src/lib/article.ts` | Pulls the readable article out of a web page |
| `src/lib/books.ts` | Library queries, saving, Gutenberg search and import |
| `src/lib/demo-book.ts` | Bundled first-visit reading sample |
| `src/lib/lemma.ts` | Rule-based English lemmatiser — runs on both server and client |
| `src/lib/words.ts` | Word index, book coverage, known words, full-text search |
| `src/lib/srs.ts` | Card generation and the Leitner schedule |
| `src/lib/stats.ts` | Reading time, streaks, review history |
| `src/lib/translate.ts` | Translation providers, dictionary lookup, caching |
| `src/lib/text-dom.ts` | Wraps words in tap targets, finds the sentence under a word |
| `src/components/Reader.tsx` | The reading surface |
| `src/components/useReadAlong.ts` | Speech synthesis with word-level highlighting |
| `src/components/TranslationCard.tsx` | The popup |
| `public/sw.js` | Offline cache for chapters and the app shell |

### Counting words without a dictionary

Coverage and flashcards both need to know that "ran", "running" and "runs" are
one word. `lemma.ts` does that with an irregular-form table plus suffix rules —
no download, no dependency, and it runs unchanged in the browser so the reader
can decide what to fade without a round trip per word.

Suffix stripping is ambiguous: "loved" could stem to `lov` or `love`. So the
lemmatiser returns candidates in priority order and picks the first one that
appears in a lexicon it is handed. When indexing a book, that lexicon is the
book's own vocabulary — a text containing "loved" almost always contains "love"
somewhere too, which settles the ambiguity from the text itself.

Contractions are reduced to their head word (`don't` → `do`, `won't` → `will`),
without which every contraction in a book is a word you can never learn.

`INDEX_VERSION` in `words.ts` guards the stored counts: bump it when the rules
change and every book re-counts itself on next read.

Books are parsed **on the server at import time** into sanitized HTML chapters
rather than rendered through an EPUB iframe. That is what makes per-word
tapping and text selection reliable — the reader owns the DOM. Incoming markup
is run through `sanitize-html` with a structural-tags-only allowlist, so no
scripts, styles, classes, or remote resources survive.

### Fetching an address the reader typed

Importing an article means the server makes a request to wherever it is told,
from inside the deployment — where the cloud metadata endpoint hands out
credentials to anything that asks and every internal service is reachable. So
`safe-fetch.ts` is used for that instead of `fetch`:

1. The hostname is resolved and **every** address it answers with is checked
   against the private, loopback, link-local, carrier-NAT and reserved ranges.
   All of them, because a name that answers with one public address and one
   loopback address is a name built to get past a check that reads the first
   entry only.
2. Each redirect is put through the same check, rather than followed. A public
   URL is free to redirect to `http://127.0.0.1:6379`.
3. The request is then made **to the address that was checked**, with a `lookup`
   that returns it and nothing else. Resolving a name, approving it and handing
   the name back to the network stack lets a one-second DNS record answer
   differently the second time; the socket goes where the check went.

That third step is why it is built on `node:https` rather than `fetch`, which
resolves names itself and cannot be told where to connect. Byte caps, the
timeout and the redirect limit come along with it — an article is at most a few
megabytes and a book at most forty.

Gutenberg downloads go through it too. Their addresses are checked against
Gutenberg's own hostnames first, but they redirect out to mirrors, and where
the bytes finally come from is not something a hostname check settles.

### Translation providers

`src/lib/translate.ts` tries providers in order and takes the first that
answers:

1. Google's public `translate_a/single` endpoint
2. MyMemory (`api.mymemory.translated.net`)

Definitions come from `api.dictionaryapi.dev`. All three are free and need no
key, and results are cached in SQLite for 30 days, so re-reading a page costs
nothing.

**Worth knowing:** the Google endpoint is undocumented and unofficial. It is
fine for personal and small-scale use, but it can rate-limit or change without
notice — so it is not something to build a public launch on. `PROVIDERS` in
`translate.ts` is a plain array of `{ name, translate }`; swapping in an
official paid API (Google Cloud Translation, DeepL) or an LLM for
context-aware explanations means adding one entry there and nothing else.

Target language is switchable in the reader's header — Kazakh is the default,
with Russian, Turkish, German, French, Spanish, Chinese, and Arabic also
wired up.

## Limits

- **Anonymous accounts, no login.** A cookie is the only credential. A second
  device can be added with a link code, but there is no way back into an
  account once every browser holding it has been cleared — nothing knows who
  you are, so nothing can be sent to you. Sign-in by emailed link is the piece
  that would fix that, and it needs a mail provider; `users.email` is the
  column it would write to, and until then nothing fills it in.
- **No upload quotas.** Anyone who can reach the server can spend its storage,
  4 MB at a time, and its translation-provider calls. A public deployment needs
  a rate limit in front of `/api/upload`, `/api/import/url` and
  `/api/translate`.
- **A book is stored per account.** Ten readers importing the same title means
  ten copies of the text. Fine for a handful of people, wasteful beyond that;
  de-duplicating means content-addressed books plus a library join table.
- **Scanned PDFs do not work** — there is no OCR, so a PDF must contain real
  selectable text. You get a clear error if it does not.
- Chapter splitting for plain text is heuristic (it looks for `CHAPTER`,
  roman numerals, and all-caps lines), so a TXT file with unusual formatting
  may divide oddly. EPUBs use their real spine and are always accurate.
- The lemmatiser is rules plus a table of irregulars, not a full dictionary. It
  handles ordinary inflection well and will occasionally mis-stem an unusual
  word, which costs a fraction of a percent on a coverage figure.
- The common-word seed list is ~700 hand-ordered words, enough to make coverage
  meaningful on day one — not a frequency-ranked corpus.
- Article extraction keeps the prose blocks of a page. It handles articles,
  posts and documentation; a heavily scripted app that renders its text with
  JavaScript will come back empty, and says so.
- Read-aloud uses the browser's own voices, so quality varies by platform.
  Word-level highlighting needs `onboundary` events, which not every engine
  fires — where they are missing the paragraph is highlighted instead.
- Only add books you have the right to use — your own files, or public-domain
  works from the Gutenberg catalog.

## Portfolio walkthrough

See [PORTFOLIO.md](PORTFOLIO.md) for a short case study and a 30-second demo
script showing the reader, word lookup, and review cards.
