import { Parser } from "htmlparser2";
import { clean, escapeHtml, type ParsedBook, type ParsedChapter } from "./ingest";
import { decodeBody, safeFetch } from "./safe-fetch";

/**
 * Turn a web page into a readable "book". No headless browser and no
 * readability dependency: strip the furniture, then keep the prose blocks in
 * document order. That is the part of readability extraction that does the
 * work, and it holds up on articles, blog posts and documentation.
 *
 * The reading is done by a real HTML parser rather than by regular
 * expressions. Both find the paragraphs on a tidy page; only the parser
 * survives the untidy ones, and untidy is the normal state of a web page. An
 * unclosed `<div>`, an attribute holding a `>`, a `<script>` containing the
 * text `</script>` in a string — each of those quietly swallows or leaks a
 * section under a pattern match, and the reader gets half an article with no
 * indication that anything went missing.
 */

/** Wrappers that never contain the article itself. */
const FURNITURE = new Set([
  "script", "style", "noscript", "svg", "head", "nav", "header",
  "footer", "aside", "form", "iframe", "template", "button", "select",
]);

/** The blocks worth keeping, in the order the page lists them. */
const BLOCKS = new Set(["h1", "h2", "h3", "h4", "p", "blockquote", "li", "pre"]);

/**
 * Tags that sit inside a sentence. Everything else that opens mid-block is a
 * boundary and gets a space, so a list run together in the markup does not come
 * out as one welded word.
 */
const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "em", "i",
  "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub",
  "sup", "time", "u", "var", "wbr", "font", "big", "tt",
]);

/** Containers that mark out the article proper, when a page bothers to use them. */
const REGIONS = new Set(["article", "main"]);

type Block = { tag: string; text: string; region: number };

type Reading = {
  blocks: Block[];
  metaTitle: string;
  docTitle: string;
  author: string;
};

/** Tidy a block's text once it has been read out of the document. */
function tidy(text: string): string {
  return (
    text
      // Footnote markers and editorial notes read as noise mid-sentence, and a
      // learner tapping "[12]" gets nothing useful back.
      .replace(/\[\s*\d{1,3}\s*\]/g, "")
      .replace(/\[\s*(?:citation|clarification|verification|page|who|when|why)[^\]]{0,20}needed\s*\]/gi, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * One pass over the document, collecting the prose blocks and the metadata.
 *
 * The parser hands events in document order, so "in order" costs nothing here;
 * the state to keep is only what we are currently inside of.
 */
function read(html: string): Reading {
  const blocks: Block[] = [];
  const meta: Record<string, string> = {};
  let docTitle = "";

  // Furniture nests, so it is a depth rather than a flag: the `</nav>` closing
  // an inner nav must not re-open the article.
  let skip = 0;
  let inSvg = 0;
  let inTitle = 0;
  let titleDone = false;
  let current: Block | null = null;
  let regionDepth = 0;
  let region = 0;
  let regions = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "meta") {
          const key = (attribs.property ?? attribs.name ?? "").toLowerCase();
          const content = attribs.content ?? "";
          if (key && content && !meta[key]) meta[key] = content;
          return;
        }
        // <title> lives in <head>, which is furniture, so it is read out from
        // under the skip rather than through it. An SVG has titles of its own —
        // the tooltip on an icon — and those are not the name of the page.
        if (name === "title") {
          if (!inSvg && !titleDone) inTitle++;
          return;
        }
        if (FURNITURE.has(name)) {
          if (name === "svg") inSvg++;
          skip++;
          return;
        }
        if (skip) return;

        if (REGIONS.has(name)) {
          // Only the outermost one names the region: an <article> nested in a
          // <main> is the same piece of writing, not a competing candidate.
          if (regionDepth === 0) region = ++regions;
          regionDepth++;
        }

        if (current) {
          if (!INLINE.has(name)) current.text += " ";
          return; // a block inside a block stays part of the outer one
        }
        if (BLOCKS.has(name)) current = { tag: name, text: "", region };
      },

      ontext(text) {
        if (inTitle) {
          docTitle += text;
          return;
        }
        if (skip || !current) return;
        current.text += text;
      },

      onclosetag(name) {
        if (name === "title") {
          if (inTitle) {
            inTitle--;
            titleDone = Boolean(docTitle.trim());
          }
          return;
        }
        if (FURNITURE.has(name)) {
          if (name === "svg" && inSvg) inSvg--;
          if (skip) skip--;
          return;
        }
        if (skip) return;

        if (REGIONS.has(name) && regionDepth > 0) {
          regionDepth--;
          if (regionDepth === 0) region = 0;
        }

        if (current) {
          if (current.tag === name) {
            const text = tidy(current.text);
            if (text) blocks.push({ ...current, text });
            current = null;
          } else if (!INLINE.has(name)) {
            current.text += " ";
          }
        }
      },
    },
    // Entities are decoded here, so nothing downstream has to guess at "&#39;".
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );

  parser.write(html);
  parser.end();

  return {
    blocks,
    metaTitle: tidy(meta["og:title"] ?? meta["twitter:title"] ?? ""),
    docTitle: tidy(docTitle),
    author: tidy(meta["author"] ?? meta["article:author"] ?? meta["og:site_name"] ?? ""),
  };
}

/** Whether a block earns its place, once we know what kind of block it is. */
function isWanted(block: Block): boolean {
  // Navigation and share links survive as one- or two-word list items.
  if (isProse(block.tag)) return block.text.length >= 40;
  if (block.tag === "li") return block.text.split(/\s+/).length >= 6;
  return true;
}

function isProse(tag: string): boolean {
  return tag === "p" || tag === "blockquote" || tag === "pre";
}

/**
 * Prefer an explicit article container when the page offers one — it keeps
 * comment threads and "related stories" lists out — but only if it holds most
 * of the prose, since some sites wrap a teaser in <article> too.
 */
function narrowToRegion(blocks: Block[]): Block[] {
  const proseIn = new Map<number, number>();
  let total = 0;
  for (const b of blocks) {
    if (!isProse(b.tag)) continue;
    total += b.text.length;
    proseIn.set(b.region, (proseIn.get(b.region) ?? 0) + b.text.length);
  }

  let best = 0;
  let bestProse = 0;
  for (const [id, prose] of proseIn) {
    if (id !== 0 && prose > bestProse) {
      best = id;
      bestProse = prose;
    }
  }

  if (!best || bestProse < total * 0.3) return blocks;
  return blocks.filter((b) => b.region === best);
}

export function extractArticle(rawHtml: string, url: string): ParsedBook {
  const { blocks, metaTitle, docTitle, author } = read(rawHtml);
  const hostname = new URL(url).hostname;

  const title = metaTitle || docTitle || hostname;

  const kept = narrowToRegion(blocks).filter(isWanted);

  const parts: string[] = [];
  let prose = 0;
  for (const block of kept) {
    if (isProse(block.tag)) prose += block.text.length;
    const tag = block.tag === "li" ? "p" : block.tag;
    parts.push(`<${tag}>${escapeHtml(block.text)}</${tag}>`);
  }

  if (prose < 200) {
    throw new Error("No article text could be found on that page.");
  }

  // Long reads get split so the reader still has chapters to move between.
  const chapters: ParsedChapter[] = [];
  const PER_CHAPTER = 60;
  for (let i = 0; i < parts.length; i += PER_CHAPTER) {
    const slice = parts.slice(i, i + PER_CHAPTER);
    chapters.push({
      title: chapters.length === 0 ? title.slice(0, 120) : `Part ${chapters.length + 1}`,
      html: clean(slice.join("\n")),
    });
  }

  return {
    title: title.slice(0, 200),
    author: (author || hostname).slice(0, 120),
    language: "en",
    chapters,
  };
}

/**
 * An article is at most a few megabytes of markup; anything far past that is a
 * file that happens to be served as HTML, and reading it into memory on a
 * serverless host helps nobody.
 */
const MAX_PAGE_BYTES = 6 * 1024 * 1024;

export async function fetchArticle(url: string): Promise<ParsedBook> {
  const res = await safeFetch(url, {
    maxBytes: MAX_PAGE_BYTES,
    timeoutMs: 20_000,
    accept: "text/html,application/xhtml+xml",
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`That page could not be fetched (HTTP ${res.status}).`);
  }

  const type = res.contentType;
  if (!/html|xml|text\/plain/.test(type)) {
    throw new Error(`That address is ${type.split(";")[0] || "not a web page"}, not an article.`);
  }

  return extractArticle(decodeBody(res), res.url);
}
