import assert from "node:assert/strict";
import test from "node:test";
import { parseGutenbergOpds } from "./gutenberg-opds";

test("parses catalog entries and pagination from Gutenberg OPDS", () => {
  const result = parseGutenbergOpds(`
    <feed xmlns="http://www.w3.org/2005/Atom">
      <link rel="next" href="/ebooks/search.opds/?start_index=26" />
      <entry>
        <id>https://www.gutenberg.org/ebooks/1342.opds</id>
        <title>Pride and Prejudice</title>
        <content type="text">Jane Austen</content>
      </entry>
    </feed>
  `);

  assert.equal(result.hasMore, true);
  assert.deepEqual(result.books[0], {
    id: 1342,
    title: "Pride and Prejudice",
    authors: "Jane Austen",
    languages: ["en"],
    subjects: [],
    downloadCount: 0,
    coverUrl: "https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg",
    textUrl: "https://www.gutenberg.org/cache/epub/1342/pg1342.txt",
  });
});

test("treats the download count used for anonymous works as metadata, not an author", () => {
  const result = parseGutenbergOpds(`
    <feed>
      <entry>
        <id>https://www.gutenberg.org/ebooks/16328.opds</id>
        <title>Beowulf</title>
        <content type="text">64,265 downloads</content>
      </entry>
    </feed>
  `);

  assert.equal(result.books[0].authors, "Unknown");
  assert.equal(result.books[0].downloadCount, 64265);
});
