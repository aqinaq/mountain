import { dayKey, getDb, plainAll } from "./db";

/**
 * Reading and review statistics. The reader sends a heartbeat while a book is
 * actually on screen, so "minutes read" means minutes with the text in front of
 * you rather than minutes since the tab was opened.
 */

/** Add time to today's total for a book. Clamped so one heartbeat cannot inflate it.
 *  reading_log is scoped through the book, so an unowned book logs nothing. */
export function logReading(userId: number, bookId: number, seconds: number): void {
  const secs = Math.max(0, Math.min(120, Math.round(seconds)));
  if (!secs) return;
  getDb()
    .prepare(
      `INSERT INTO reading_log (day, book_id, seconds)
       SELECT ?, id, ? FROM books WHERE id = ? AND user_id = ?
       ON CONFLICT(day, book_id) DO UPDATE SET seconds = seconds + excluded.seconds`,
    )
    .run(dayKey(), secs, bookId, userId);
}

export type DayStat = { day: string; seconds: number; reviewed: number; correct: number };

export type Stats = {
  streak: number;
  longestStreak: number;
  todaySeconds: number;
  totalSeconds: number;
  daysRead: number;
  vocabTotal: number;
  knownTotal: number;
  dueTotal: number;
  reviewedTotal: number;
  correctTotal: number;
  booksStarted: number;
  wordsRead: number;
  days: DayStat[];
};

function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d + delta);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Consecutive days ending today (or yesterday — today still being open). */
function streakFrom(active: Set<string>): { current: number; longest: number } {
  const today = dayKey();
  let cursor = active.has(today) ? today : shiftDay(today, -1);
  let current = 0;
  while (active.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }

  const sorted = [...active].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    run = prev && shiftDay(prev, 1) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }

  return { current, longest };
}

export function getStats(userId: number, windowDays = 84): Stats {
  const db = getDb();

  const reading = plainAll(
    db
      .prepare(
        `SELECT r.day, SUM(r.seconds) AS seconds
           FROM reading_log r JOIN books b ON b.id = r.book_id
          WHERE b.user_id = ?
          GROUP BY r.day`,
      )
      .all(userId) as { day: string; seconds: number }[],
  );
  const reviews = plainAll(
    db.prepare("SELECT day, reviewed, correct FROM review_log WHERE user_id = ?").all(userId) as {
      day: string;
      reviewed: number;
      correct: number;
    }[],
  );

  const byDay = new Map<string, DayStat>();
  for (const r of reading) {
    byDay.set(r.day, { day: r.day, seconds: r.seconds, reviewed: 0, correct: 0 });
  }
  for (const r of reviews) {
    const entry = byDay.get(r.day) ?? { day: r.day, seconds: 0, reviewed: 0, correct: 0 };
    entry.reviewed = r.reviewed;
    entry.correct = r.correct;
    byDay.set(r.day, entry);
  }

  // A dense window, so the calendar can render gaps as gaps.
  const today = dayKey();
  const days: DayStat[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = shiftDay(today, -i);
    days.push(byDay.get(day) ?? { day, seconds: 0, reviewed: 0, correct: 0 });
  }

  const active = new Set(
    [...byDay.values()].filter((d) => d.seconds > 0 || d.reviewed > 0).map((d) => d.day),
  );
  const { current, longest } = streakFrom(active);

  const one = (sql: string, ...args: (string | number)[]) =>
    (db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;

  return {
    streak: current,
    longestStreak: longest,
    todaySeconds: byDay.get(today)?.seconds ?? 0,
    totalSeconds: reading.reduce((sum, r) => sum + r.seconds, 0),
    daysRead: active.size,
    vocabTotal: one("SELECT COUNT(*) AS n FROM vocab WHERE user_id = ?", userId),
    knownTotal: one("SELECT COUNT(*) AS n FROM known_words WHERE user_id = ?", userId),
    dueTotal: one(
      `SELECT COUNT(*) AS n FROM cards c JOIN vocab v ON v.id = c.vocab_id
        WHERE v.user_id = ? AND c.due_at <= ?`,
      userId,
      Date.now(),
    ),
    reviewedTotal: reviews.reduce((sum, r) => sum + r.reviewed, 0),
    correctTotal: reviews.reduce((sum, r) => sum + r.correct, 0),
    booksStarted: one(
      `SELECT COUNT(*) AS n FROM progress p JOIN books b ON b.id = p.book_id
        WHERE b.user_id = ? AND (p.chapter_idx > 0 OR p.scroll_pct > 0)`,
      userId,
    ),
    // An estimate: pages actually turned, priced at the book's own word count.
    wordsRead: one(
      `SELECT COALESCE(CAST(SUM(b.word_count * MIN(1.0,
                (p.chapter_idx + p.scroll_pct) * 1.0 /
                MAX(1, (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id)))) AS INTEGER), 0) AS n
         FROM progress p JOIN books b ON b.id = p.book_id
        WHERE b.user_id = ?`,
      userId,
    ),
    days,
  };
}
