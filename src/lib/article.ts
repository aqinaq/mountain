import { clean, escapeHtml, type ParsedBook, type ParsedChapter } from "./ingest";

/**
 * Turn a web page into a readable "book". No headless browser and no
 * readability dependency: strip the furniture, then keep the prose blocks in
 * document order. That is the part of readability extraction that does the
 * work, and it holds up on articles, blog posts and documentation.
 */

/** Wrappers that never contain the article itself. */
const FURNITURE =
  /<(script|style|noscript|svg|head|nav|header|footer|aside|form|iframe|template|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** The blocks worth keeping, in the order the page lists them. */
const BLOCK_RE = /<(h1|h2|h3|h4|p|blockquote|li|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    // Footnote markers and editorial notes read as noise mid-sentence, and a
    // learner tapping "[12]" gets nothing useful back.
    .replace(/\[\s*\d{1,3}\s*\]/g, "")
    .replace(/\[\s*(?:citation|clarification|verification|page|who|when|why)[^\]]{0,20}needed\s*\]/gi, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, ...names: string[]): string {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      "i",
    );
    const alt = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
      "i",
    );
    const m = re.exec(html) ?? alt.exec(html);
    if (m?.[1]) return textOf(m[1]);
  }
  return "";
}

/**
 * Prefer an explicit article container when the page offers one — it keeps
 * comment threads and "related stories" lists out — but only if it holds most
 * of the prose, since some sites wrap a teaser in <article> too.
 */
function mainRegion(html: string): string {
  let best = "";
  for (const tag of ["article", "main"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    for (const m of html.matchAll(re)) {
      if (m[1].length > best.length) best = m[1];
    }
  }
  return best.length > html.length * 0.15 ? best : html;
}

export function extractArticle(rawHtml: string, url: string): ParsedBook {
  const stripped = rawHtml.replace(FURNITURE, " ").replace(/<!--[\s\S]*?-->/g, " ");

  const title =
    metaContent(rawHtml, "og:title", "twitter:title") ||
    textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml)?.[1] ?? "") ||
    new URL(url).hostname;
  const author =
    metaContent(rawHtml, "author", "article:author", "og:site_name") || new URL(url).hostname;

  const region = mainRegion(stripped);

  const parts: string[] = [];
  let prose = 0;
  for (const m of region.matchAll(BLOCK_RE)) {
    const tag = m[1].toLowerCase();
    const text = textOf(m[2]);
    if (!text) continue;

    // Navigation and share links survive as one- or two-word list items.
    const isProse = /^(p|blockquote|pre)$/.test(tag);
    if (isProse && text.length < 40) continue;
    if (tag === "li" && text.split(/\s+/).length < 6) continue;

    if (isProse) prose += text.length;
    parts.push(`<${tag === "li" ? "p" : tag}>${escapeHtml(text)}</${tag === "li" ? "p" : tag}>`);
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

  return { title: title.slice(0, 200), author: author.slice(0, 120), language: "en", chapters };
}

export async function fetchArticle(url: string): Promise<ParsedBook> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That does not look like a web address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https addresses can be imported.");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(parsed, {
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MountainReader/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`That page could not be fetched (HTTP ${res.status}).`);

    const type = res.headers.get("content-type") ?? "";
    if (!/html|xml|text\/plain/.test(type)) {
      throw new Error(`That address is ${type.split(";")[0] || "not a web page"}, not an article.`);
    }

    return extractArticle(await res.text(), parsed.toString());
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("That page took too long to respond.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
