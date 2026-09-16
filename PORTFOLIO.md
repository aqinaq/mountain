# Mountain — reading that becomes learning

English learners often stop reading when too many unfamiliar words interrupt
the story. Mountain keeps the book and the explanation on one reading surface:
tap a word for a translation, save it in the sentence where it appeared, and
review it later. The initial language is Kazakh, with seven other target
languages available in the reader.

## A 30-second walkthrough

1. **0–5 seconds:** Open an empty library and choose **Read the sample**. A
   bundled two-chapter story opens without signup or an external catalog call.
2. **5–15 seconds:** Tap *ridge* in the first chapter. Show the word card and
   the sentence it came from; translation and dictionary detail appear when
   the free providers respond.
3. **15–25 seconds:** Save the word, then return to **Vocabulary**. The saved
   context becomes recognition, production, and fill-in-the-blank cards.
4. **25–30 seconds:** Return to the library and show reading progress and the
   book's known-word coverage.

## What I built

The reader parses EPUB, PDF, text, subtitles, and web articles into sanitized
chapters on the server. That makes every word tappable and keeps foreign
scripts and styles out of the reading page. A SQLite FTS5 index supports
in-book search; a lemma index connects inflected forms to coverage and known
words. Each browser begins with an anonymous account, and one-use codes can
join a second device without a password. libSQL stores both the parsed text
and original uploaded bytes, using a local file for development and Turso for
deployment. A service worker caches opened chapters for offline reading.

## What a reviewer should see

Capture three screens for a portfolio page: the **empty library with its
sample action**, the **reader with a word card open**, and **Vocabulary with
three cards due**. Keep the captions focused on the learner's flow: start
reading, understand in context, then practice recall. The live demo should
begin on a fresh account so the sample action is visible.

## Limits and next steps

There is no account recovery after every linked browser loses its cookie.
Translation and dictionary detail depend on free external services and may be
slower or incomplete. Scanned PDFs need OCR, and a public launch needs upload
and translation quotas. I have not measured learner outcomes, so this case
study describes the workflow and technical behavior rather than claiming an
improvement in reading proficiency.
