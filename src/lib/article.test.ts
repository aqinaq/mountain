import assert from "node:assert/strict";
import test from "node:test";
import { extractArticle } from "./article";

const URL_UNDER_TEST = "https://example.com/piece";

/** Enough prose to clear the "is there an article here at all" threshold. */
const PARA = (n: number) =>
  `<p>Paragraph number ${n}. It is written out at some length so that it counts as prose ` +
  `rather than as a caption or a piece of navigation furniture.</p>`;

const body = (inner: string) => `<!doctype html><html><body>${inner}</body></html>`;

function textOf(book: { chapters: { html: string }[] }): string {
  return book.chapters.map((c) => c.html).join("\n");
}

test("keeps the prose and drops the furniture", () => {
  const book = extractArticle(
    body(`
      <nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
      <header><p>Sign up for our newsletter and never miss a thing at all</p></header>
      ${PARA(1)}${PARA(2)}
      <footer><p>Copyright some corporation, all rights reserved, terms and conditions</p></footer>
    `),
    URL_UNDER_TEST,
  );

  const text = textOf(book);
  assert.match(text, /Paragraph number 1/);
  assert.match(text, /Paragraph number 2/);
  assert.doesNotMatch(text, /newsletter/);
  assert.doesNotMatch(text, /Copyright/);
  assert.doesNotMatch(text, /About/);
});

test("a script that contains markup does not swallow the article", () => {
  // The regex version read to the first `</script>` *in the source*, so the one
  // inside the string ended the block early and the JSON leaked into the book.
  const book = extractArticle(
    body(`
      ${PARA(1)}
      <script>var s = "</p><p>tracking pixel</p>"; var t = "</script>";</script>
      ${PARA(2)}
    `),
    URL_UNDER_TEST,
  );

  const text = textOf(book);
  assert.match(text, /Paragraph number 1/);
  assert.match(text, /Paragraph number 2/);
  assert.doesNotMatch(text, /tracking pixel/);
  assert.doesNotMatch(text, /var s/);
});

test("an attribute holding a > does not hide the paragraph behind it", () => {
  const book = extractArticle(
    body(`<div data-tip="a > b"><span title="x > y">${PARA(1)}${PARA(2)}</span></div>`),
    URL_UNDER_TEST,
  );

  assert.match(textOf(book), /Paragraph number 1/);
  assert.match(textOf(book), /Paragraph number 2/);
});

test("unclosed tags still yield their paragraphs", () => {
  const book = extractArticle(
    body(`
      <div><p>An opening paragraph that was never closed off by the person writing it.
      <p>A second one, in the same unclosed style, which is how a great many pages are written.
      <p>And a third, so that there is enough prose here to be recognised as an article.
    `),
    URL_UNDER_TEST,
  );

  assert.equal(textOf(book).match(/<p>/g)?.length, 3);
  assert.match(textOf(book), /never closed off/);
  assert.match(textOf(book), /And a third/);
});

test("entities are decoded, not left as text", () => {
  const book = extractArticle(
    body(`
      <p>Salt &amp; pepper, and the reader&#8217;s own copy &mdash; that is the whole idea here.</p>
      ${PARA(1)}${PARA(2)}
    `),
    URL_UNDER_TEST,
  );

  const text = textOf(book);
  assert.match(text, /Salt &amp; pepper/); // re-escaped for storage, not the literal "&amp;amp;"
  assert.doesNotMatch(text, /&amp;amp;|&amp;#8217;|&amp;mdash;/);
  assert.match(text, /reader’s/);
});

test("an article region wins over the page around it", () => {
  const book = extractArticle(
    body(`
      <aside>${PARA(90)}</aside>
      <article>${PARA(1)}${PARA(2)}${PARA(3)}${PARA(4)}</article>
      <div class="related">${PARA(91)}</div>
    `),
    URL_UNDER_TEST,
  );

  const text = textOf(book);
  assert.match(text, /Paragraph number 1/);
  assert.doesNotMatch(text, /Paragraph number 90/);
  assert.doesNotMatch(text, /Paragraph number 91/);
});

test("a page whose <article> holds only a teaser keeps the whole page", () => {
  const book = extractArticle(
    body(`
      <article><p>A short teaser, well under the weight of the piece itself.</p></article>
      <div id="content">${PARA(1)}${PARA(2)}${PARA(3)}${PARA(4)}${PARA(5)}</div>
    `),
    URL_UNDER_TEST,
  );

  assert.match(textOf(book), /Paragraph number 5/);
});

test("short list items go, long ones stay", () => {
  const book = extractArticle(
    body(`
      ${PARA(1)}${PARA(2)}
      <ul>
        <li>Share</li>
        <li>Print this</li>
        <li>A list item long enough to be a real sentence in the body of the piece.</li>
      </ul>
    `),
    URL_UNDER_TEST,
  );

  const text = textOf(book);
  assert.match(text, /real sentence in the body/);
  assert.doesNotMatch(text, /Share/);
  assert.doesNotMatch(text, /Print this/);
});

test("text is not welded together across block boundaries", () => {
  const book = extractArticle(
    body(
      `${PARA(1)}${PARA(2)}<blockquote><p>The first part of the quotation.</p>` +
        `<p>The second part of it, which follows on.</p></blockquote>`,
    ),
    URL_UNDER_TEST,
  );

  assert.match(textOf(book), /the quotation\. The second part/);
});

test("inline markup inside a word is not broken by a space", () => {
  const book = extractArticle(
    body(`${PARA(1)}${PARA(2)}<p>The <em>inter</em>national reply coupon, and nothing else.</p>`),
    URL_UNDER_TEST,
  );

  assert.match(textOf(book), /international reply coupon/);
});

test("footnote markers are dropped", () => {
  const book = extractArticle(
    body(
      `${PARA(1)}${PARA(2)}<p>A claim that somebody, at some point, once had cause ` +
        `to question.[12][citation needed]</p>`,
    ),
    URL_UNDER_TEST,
  );

  const text = textOf(book);
  assert.match(text, /once had cause to question\./);
  assert.doesNotMatch(text, /\[12\]|citation needed/);
});

test("the title comes from the page, and falls back to the host", () => {
  const withMeta = extractArticle(
    `<html><head><meta property="og:title" content="The Real Title"><title>Ignored — Site</title></head>` +
      `<body>${PARA(1)}${PARA(2)}</body></html>`,
    URL_UNDER_TEST,
  );
  assert.equal(withMeta.title, "The Real Title");

  const withTitleTag = extractArticle(
    `<html><head><title>A Piece &amp; Its Name</title></head><body>${PARA(1)}${PARA(2)}</body></html>`,
    URL_UNDER_TEST,
  );
  assert.equal(withTitleTag.title, "A Piece & Its Name");

  const bare = extractArticle(body(`${PARA(1)}${PARA(2)}`), URL_UNDER_TEST);
  assert.equal(bare.title, "example.com");
  assert.equal(bare.author, "example.com");

  // An <svg><title> is an icon's tooltip, not the name of the page.
  const withIcons = extractArticle(
    `<html><head><title>The Page</title></head><body>` +
      `<p><svg><title>Share on social media</title></svg></p>${PARA(1)}${PARA(2)}</body></html>`,
    URL_UNDER_TEST,
  );
  assert.equal(withIcons.title, "The Page");
});

test("a page with no article in it is refused rather than half-imported", () => {
  assert.throws(
    () => extractArticle(body("<nav><ul><li>Home</li><li>About</li></ul></nav>"), URL_UNDER_TEST),
    /No article text/,
  );
  assert.throws(() => extractArticle(body("<p>Too short.</p>"), URL_UNDER_TEST), /No article text/);
});

test("a long read is split into chapters", () => {
  const many = Array.from({ length: 130 }, (_, i) => PARA(i)).join("");
  const book = extractArticle(body(many), URL_UNDER_TEST);

  assert.equal(book.chapters.length, 3); // 60 blocks each
  assert.equal(book.chapters[1].title, "Part 2");
});
