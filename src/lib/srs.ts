import { dayKey, getDb, plainAll } from "./db";
import { lemma, lemmaCandidates } from "./lemma";
import { markKnown } from "./words";

/**
 * Spaced repetition. One saved word becomes up to three cards, each on its own
 * schedule:
 *
 *   recognize — English word → your language. The easy direction.
 *   produce   — your language → English. Harder, and where recall is actually built.
 *   cloze     — the sentence you met the word in, with the word blanked out.
 *
 * Scheduling stays a five-box Leitner ladder: right answers move a card up,
 * wrong ones send it back to box 1.
 */

export const CARD_TYPES = ["recognize", "produce", "cloze"] as const;
export type CardType = (typeof CARD_TYPES)[number];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Time until a card comes back, indexed by box (1..5).
 *
 * Box 1 is minutes, not a day: a card you just missed is one you are still
 * learning, and it should come round again in the same sitting. Everything
 * above it is the usual widening ladder.
 */
const INTERVALS = [0, 10 * MINUTE, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
const MAX_BOX = 5;

export type DueCard = {
  id: number;
  vocab_id: number;
  type: CardType;
  box: number;
  due_at: number;
  term: string;
  translation: string;
  context: string;
  lemma: string;
  book_title: string | null;
};

/**
 * Create the card set for a vocabulary entry. Cloze only exists when we captured
 * the sentence and can actually find the word in it; a phrase gets no cloze
 * either, since blanking the whole phrase leaves nothing to read.
 */
export function ensureCards(vocabId: number): void {
  const db = getDb();
  const row = db
    .prepare("SELECT term, context, kind, lemma, box, due_at FROM vocab WHERE id = ?")
    .get(vocabId) as
    | { term: string; context: string; kind: string; lemma: string; box: number; due_at: number }
    | undefined;
  if (!row) return;

  const wanted: CardType[] = ["recognize", "produce"];
  if (row.kind !== "phrase" && clozeFront(row.context, row.term, row.lemma)) wanted.push("cloze");

  const insert = db.prepare(
    `INSERT INTO cards (vocab_id, type, box, due_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vocab_id, type) DO NOTHING`,
  );
  for (const type of wanted) {
    // A pre-existing entry keeps whatever progress the old single-card schedule
    // had, on the direction that schedule was actually testing.
    const box = type === "recognize" ? Math.max(1, row.box) : 1;
    const dueAt = type === "recognize" ? row.due_at : Date.now();
    insert.run(vocabId, type, box, dueAt, Date.now());
  }
}

/** Give every vocabulary entry its cards — for rows saved before cards existed. */
export function backfillCards(userId: number): void {
  const ids = getDb()
    .prepare("SELECT id FROM vocab WHERE user_id = ? AND id NOT IN (SELECT vocab_id FROM cards)")
    .all(userId) as { id: number }[];
  for (const { id } of ids) ensureCards(id);
}

/**
 * The sentence with the word blanked out, or null when the word cannot be found
 * in it — the context may hold an inflected form, so every candidate surface
 * form of the lemma is tried before giving up.
 */
export function clozeFront(context: string, term: string, storedLemma?: string): string | null {
  const text = (context ?? "").trim();
  if (!text || text.length < 12) return null;

  const base = (storedLemma || lemma(term)).toLowerCase();
  const blank = " ____ ";

  // Any token in the sentence that shares the term's lemma is the blank.
  let found = false;
  const out = text.replace(/[\p{L}][\p{L}\p{M}'’-]*/gu, (token) => {
    if (found) return token;
    const t = token.toLowerCase();
    if (t === term.toLowerCase() || lemmaCandidates(t).includes(base)) {
      found = true;
      return blank;
    }
    return token;
  });

  return found ? out : null;
}

/** Cards ready for review, oldest due first. Filter by type in SQL, not after
 *  the limit — otherwise a session of one card type comes back nearly empty
 *  whenever the other types happen to be due first. */
export function dueCards(userId: number, limit = 40, type?: CardType | null): DueCard[] {
  const args: (string | number)[] = [userId, Date.now()];
  if (type) args.push(type);
  args.push(limit);

  return plainAll(
    getDb()
      .prepare(
        `SELECT c.id, c.vocab_id, c.type, c.box, c.due_at,
                v.term, v.translation, v.context, v.lemma,
                b.title AS book_title
           FROM cards c
           JOIN vocab v ON v.id = c.vocab_id
           LEFT JOIN books b ON b.id = v.book_id
          WHERE v.user_id = ? AND c.due_at <= ?${type ? " AND c.type = ?" : ""}
          ORDER BY c.due_at, c.id
          LIMIT ?`,
      )
      .all(...args) as DueCard[],
  );
}

export type DueBreakdown = { total: number; recognize: number; produce: number; cloze: number };

export function dueBreakdown(userId: number): DueBreakdown {
  const rows = getDb()
    .prepare(
      `SELECT c.type, COUNT(*) AS n
         FROM cards c JOIN vocab v ON v.id = c.vocab_id
        WHERE v.user_id = ? AND c.due_at <= ?
        GROUP BY c.type`,
    )
    .all(userId, Date.now()) as { type: CardType; n: number }[];

  const out: DueBreakdown = { total: 0, recognize: 0, produce: 0, cloze: 0 };
  for (const r of rows) {
    out[r.type] = r.n;
    out.total += r.n;
  }
  return out;
}

/**
 * Record an answer. A card that survives the top box is a word you know, so it
 * graduates into `known_words` and starts counting towards book coverage.
 */
export function answerCard(
  userId: number,
  cardId: number,
  correct: boolean,
): { box: number; dueAt: number } | null {
  const db = getDb();
  const card = db
    .prepare(
      `SELECT c.box, c.type, v.term, v.lemma
         FROM cards c JOIN vocab v ON v.id = c.vocab_id
        WHERE c.id = ? AND v.user_id = ?`,
    )
    .get(cardId, userId) as { box: number; type: CardType; term: string; lemma: string } | undefined;
  if (!card) return null;

  const box = correct ? Math.min(MAX_BOX, card.box + 1) : 1;
  const dueAt = Date.now() + INTERVALS[box];

  db.prepare(
    `UPDATE cards
        SET box = ?, due_at = ?, reps = reps + 1, lapses = lapses + ?
      WHERE id = ?`,
  ).run(box, dueAt, correct ? 0 : 1, cardId);

  const day = dayKey();
  db.prepare(
    `INSERT INTO review_log (user_id, day, reviewed, correct) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET
       reviewed = reviewed + 1, correct = correct + excluded.correct`,
  ).run(userId, day, correct ? 1 : 0);

  if (correct && card.box >= MAX_BOX) {
    const base = card.lemma || lemma(card.term);
    if (base && !base.includes(" ")) markKnown(userId, [base]);
  }

  return { box, dueAt };
}
