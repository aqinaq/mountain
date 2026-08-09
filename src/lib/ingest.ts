import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import sanitizeHtml from "sanitize-html";
import path from "node:path";

export type ParsedChapter = { title: string; html: string };
export type ParsedBook = {
  title: string;
  author: string;
  language: string;
  chapters: ParsedChapter[];
  coverDataUrl?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // A single <item> and a list of <item>s should both come back as arrays.
  isArray: (name) => ["item", "itemref", "reference"].includes(name),
});

/** Keep structural tags only. No scripts, no styles, no remote resources. */
export function clean(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr", "blockquote", "pre", "em", "i", "strong", "b",
      "small", "sub", "sup", "ul", "ol", "li", "dl", "dt", "dd",
      "figure", "figcaption", "section", "div", "span",
    ],
    allowedAttributes: {},
    // Images are dropped: they'd be zip-internal paths we can't resolve, and
    // the reader is text-first anyway.
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "svg"],
  })
    .replace(/(&nbsp;| )/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(chapters: ParsedChapter[]): number {
  let n = 0;
  for (const c of chapters) {
    const t = stripTags(c.html);
    if (t) n += t.split(/\s+/).length;
  }
  return n;
}

/** Resolve an href relative to the OPF file's own directory, zip-style. */
function resolveFromOpf(opfPath: string, href: string): string {
  const dir = path.posix.dirname(opfPath);
  const joined = dir === "." ? href : path.posix.join(dir, href);
  return decodeURIComponent(joined.replace(/^\.\//, ""));
}

function firstText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return firstText(v[0]);
  if (typeof v === "object") return firstText((v as Record<string, unknown>)["#text"]);
  return "";
}

/**
 * Pull a readable chapter title: an <h*> if present, else the first line. When
 * that heading opens the chapter it is also lifted out of the body — the reader
 * renders the title itself, so leaving it in prints it twice.
 */
function splitTitle(html: string, fallback: string): { title: string; html: string } {
  const h = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i.exec(html);
  if (h) {
    const title = stripTags(h[2]).slice(0, 120);
    if (title) {
      const opensChapter = !stripTags(html.slice(0, h.index));
      const body = opensChapter
        ? `${html.slice(0, h.index)}${html.slice(h.index + h[0].length)}`.trim()
        : html;
      return { title, html: body };
    }
  }
  const t = stripTags(html).slice(0, 60).trim();
  return { title: t ? `${t}…` : fallback, html };
}

export async function parseEpub(buf: Buffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buf);

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("Not a valid EPUB: META-INF/container.xml is missing.");
  const container = parser.parse(await containerFile.async("string"));
  const rootfile = container?.container?.rootfiles?.rootfile;
  const opfPath: string | undefined = Array.isArray(rootfile)
    ? rootfile[0]?.["@_full-path"]
    : rootfile?.["@_full-path"];
  if (!opfPath) throw new Error("Not a valid EPUB: no rootfile declared.");

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`Not a valid EPUB: ${opfPath} is missing.`);
  const opf = parser.parse(await opfFile.async("string"));
  const pkg = opf.package ?? {};
  const meta = pkg.metadata ?? {};

  const title = firstText(meta["dc:title"] ?? meta.title) || "Untitled";
  const author = firstText(meta["dc:creator"] ?? meta.creator);
  const language = (firstText(meta["dc:language"] ?? meta.language) || "en").slice(0, 5);

  const items: Record<string, { href: string; type: string }> = {};
  for (const it of pkg.manifest?.item ?? []) {
    const id = it["@_id"];
    if (id) items[id] = { href: it["@_href"] ?? "", type: it["@_media-type"] ?? "" };
  }

  const spine: string[] = (pkg.spine?.itemref ?? [])
    .map((r: Record<string, string>) => r["@_idref"])
    .filter(Boolean);

  const chapters: ParsedChapter[] = [];
  for (const idref of spine) {
    const item = items[idref];
    if (!item || !/xhtml|html/i.test(item.type)) continue;

    const entry = zip.file(resolveFromOpf(opfPath, item.href));
    if (!entry) continue;

    const raw = await entry.async("string");
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ?? raw;
    const cleaned = clean(body);
    if (stripTags(cleaned).length < 40) continue; // skip covers, blank pages, nav stubs

    chapters.push(splitTitle(cleaned, `Section ${chapters.length + 1}`));
  }

  if (!chapters.length) throw new Error("Could not extract any readable text from this EPUB.");
  return { title, author, language, chapters };
}

/**
 * Plain text: split on blank-line-separated blocks, then group into chapters at
 * heading-ish lines (CHAPTER I, 1., all-caps short lines). Falls back to fixed
 * size chunks so a wall of text still paginates sensibly.
 */
export function parseText(text: string, fallbackTitle: string): ParsedBook {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/ /g, " ");

  // Gutenberg plain-text files wrap the work in a licence header/footer.
  const start = normalized.search(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  const end = normalized.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  let body = normalized;
  if (start !== -1) body = body.slice(normalized.indexOf("\n", start) + 1);
  if (end !== -1) body = body.slice(0, end - (start !== -1 ? normalized.indexOf("\n", start) + 1 : 0));

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

  const isHeading = (p: string) =>
    p.length < 90 &&
    (/^(chapter|book|part|act|scene|canto|letter)\b/i.test(p) ||
      /^[IVXLC]+\.?$/.test(p) ||
      /^\d+\.?$/.test(p) ||
      (p === p.toUpperCase() && /[A-Z]/.test(p) && p.length > 2));

  const chapters: ParsedChapter[] = [];
  let current: { title: string; paras: string[] } | null = null;
  const push = () => {
    if (current && current.paras.length) {
      chapters.push({
        title: current.title,
        html: current.paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
      });
    }
  };

  for (const p of paragraphs) {
    if (isHeading(p)) {
      push();
      current = { title: p.slice(0, 120), paras: [] };
    } else {
      if (!current) current = { title: "Beginning", paras: [] };
      current.paras.push(p);
      // Guard against a book with no detectable headings at all.
      if (current.paras.length >= 120) {
        push();
        current = { title: `${current.title} (cont.)`, paras: [] };
      }
    }
  }
  push();

  if (!chapters.length) throw new Error("This file contains no readable text.");
  return { title: fallbackTitle, author: "", language: "en", chapters };
}

const TIMECODE_RE = /^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/;

/**
 * SRT / WebVTT subtitles. Cues are stripped of their numbering and timings and
 * then re-joined into sentences: a subtitle file is a transcript broken every
 * few words for the screen, and reading it that way is unbearable.
 */
export function parseSubtitles(text: string, fallbackTitle: string): ParsedBook {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");

  const lines: string[] = [];
  for (const block of normalized.split(/\n\s*\n/)) {
    const kept = block
      .split("\n")
      .filter((line, i) => {
        const l = line.trim();
        if (!l) return false;
        if (TIMECODE_RE.test(l)) return false;
        if (i === 0 && /^\d+$/.test(l)) return false; // cue number
        if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(l)) return false;
        return true;
      })
      .map((l) =>
        l
          .replace(/<[^>]+>/g, "") // <i>, <font color=…>
          .replace(/\{\\[^}]*\}/g, "") // ASS override tags
          .replace(/^\s*[-–—]\s*/, "") // speaker dashes
          .trim(),
      )
      .filter(Boolean);

    if (kept.length) lines.push(kept.join(" "));
  }

  if (!lines.length) throw new Error("No subtitle text could be read from this file.");

  // Re-flow cues into paragraphs, breaking where a sentence ends.
  const paragraphs: string[] = [];
  let buffer = "";
  for (const line of lines) {
    buffer = buffer ? `${buffer} ${line}` : line;
    if (/[.!?…]["'’”]?$/.test(line) && buffer.split(/\s+/).length > 25) {
      paragraphs.push(buffer);
      buffer = "";
    }
  }
  if (buffer) paragraphs.push(buffer);

  const chapters: ParsedChapter[] = [];
  const PER_CHAPTER = 40;
  for (let i = 0; i < paragraphs.length; i += PER_CHAPTER) {
    chapters.push({
      title: `Part ${chapters.length + 1}`,
      html: paragraphs
        .slice(i, i + PER_CHAPTER)
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("\n"),
    });
  }

  return { title: fallbackTitle, author: "", language: "en", chapters };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// PDF extraction lives in ./pdf-layout — it needs the page geometry, not just
// the text, to recover paragraphs and headings.
