import { getDb } from "./db";
import { parseText } from "./ingest";
import { saveBook } from "./books";

const SOURCE_ID = "mountain-demo-v1";

// Original sample text bundled with the app, so a first visit can try the
// reader even when the external catalog or translation providers are down.
const TEXT = `CHAPTER ONE — THE PATH

At the edge of the city, a narrow path climbed toward the mountains. Amina had walked past it many times, but she had never followed it. This morning she carried a small book and decided to see where the path went.

The first page described a valley hidden between two ridges. Amina knew the word valley, but ridge was new. She tapped it and read the explanation before looking up at the land around her. Two long lines of stone rose on either side of the path. Now the word belonged to something she could see.

Farther uphill, the air grew cool. She stopped beside a stream and read another paragraph. A bird crossed the water and vanished into the trees. The sentence in her book used the word vanish. Amina said it aloud, then watched the bird disappear. She saved the word to practice later.

CHAPTER TWO — A SMALL DISCOVERY

By noon, the path opened onto a quiet meadow. The grass moved in the wind, and the city looked very small below. Amina sat down, opened her book again, and noticed that the difficult page from the morning had become easier.

She did not understand every word. She could still follow the story. When a sentence confused her, she read it twice and looked at the words around it. Sometimes the meaning arrived before she needed a translation.

On the way home, Amina thought about the three words she had learned: ridge, vanish, and meadow. Each one had a place in her memory now. Tomorrow she would review them, and perhaps walk farther along the path.`;

/** Add the same short reader sample once per account. */
export async function ensureDemoBook(userId: number): Promise<number> {
  const db = await getDb();
  const existing = await db.get<{ id: number }>(
    "SELECT id FROM books WHERE user_id = ? AND source = 'demo' AND source_id = ?",
    userId,
    SOURCE_ID,
  );
  if (existing) return existing.id;

  const parsed = parseText(TEXT, "The Path");
  return saveBook({
    userId,
    parsed: { ...parsed, author: "Mountain sample" },
    source: "demo",
    sourceId: SOURCE_ID,
  });
}
