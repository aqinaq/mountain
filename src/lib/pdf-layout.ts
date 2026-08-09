/**
 * Layout-aware PDF extraction.
 *
 * `getTextContent()` on its own hands back one flat run of words per page, which
 * throws away everything that makes a book readable: where paragraphs start,
 * which lines are headings, which lines are just the running head repeated 240
 * times. Everything here works from the geometry pdf.js *does* give us — the
 * x/y, size and font of every fragment — and rebuilds that structure.
 */

import { escapeHtml, type ParsedBook, type ParsedChapter } from "./ingest";

/* ------------------------------------------------------------------ */
/* fragments and lines                                                  */
/* ------------------------------------------------------------------ */

type Frag = {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
  /** A whitespace-only run. pdf.js emits these between font changes — an italic
   *  phrase mid-sentence is preceded by its own space item — and the glyphs on
   *  either side can abut, so the gap alone would not give the space away. */
  space: boolean;
};

type Line = {
  page: number;
  y: number;
  x0: number;
  x1: number;
  size: number;
  /** Set in a font other than the one this page is mostly set in. pdf.js hands
   *  out font aliases per page, so this can only ever be a within-page comparison. */
  offFont: boolean;
  text: string;
  caps: boolean;
  center: number;
  pageWidth: number;
};

// Footnote markers are kept as sentinels so they survive escaping and only
// become <sup> at the very end.
const SUP_OPEN = "";
const SUP_CLOSE = "";

/* ------------------------------------------------------------------ */
/* letter-spacing repair                                                */
/* ------------------------------------------------------------------ */

/**
 * Display type in books is often tracked out ("T H E  M O U N T A I N"). pdf.js
 * turns every one of those glyph gaps into a space and the word gaps become
 * indistinguishable from them, so the extracted string can't be un-spaced by
 * looking at it alone.
 */
function looksLetterSpaced(s: string): boolean {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const singles = tokens.filter((t) => t.length === 1 && /[\p{L}\d]/u.test(t)).length;
  // Kerning pairs survive as one token ("MOUNTAIN" → "M O U N TA I N"), so allow
  // a few; a two-token run has to be all singles to count.
  return tokens.length >= 4 ? singles / tokens.length >= 0.6 : singles === tokens.length;
}

/**
 * The operator list still holds the *real* string, spaces and all — the tracking
 * lives in the graphics state, not in the text. Indexing a page's operator text
 * by its whitespace-stripped form lets us look a mangled fragment back up.
 */
type RepairIndex = { compact: string; original: string; map: number[] };

function buildRepairIndex(ops: {
  fnArray: number[];
  argsArray: unknown[][];
}, showText: number, showSpacedText: number): RepairIndex {
  let original = "";
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== showText && fn !== showSpacedText) continue;
    const glyphs = ops.argsArray[i]?.[0];
    if (!Array.isArray(glyphs)) continue;
    for (const g of glyphs) {
      if (typeof g === "number" || g == null) continue;
      const u = (g as { unicode?: string }).unicode;
      if (typeof u === "string") original += u;
    }
    original += "\n"; // runs must not bleed into each other
  }

  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    if (/\s/.test(original[i])) continue;
    chars.push(original[i]);
    map.push(i);
  }
  return { compact: chars.join(""), original, map };
}

function repair(fragment: string, idx: RepairIndex | null): string {
  if (!idx) return fragment;
  const needle = fragment.replace(/\s+/g, "");
  if (!needle) return fragment;
  const at = idx.compact.indexOf(needle);
  if (at < 0) return fragment;
  const from = idx.map[at];
  const to = idx.map[at + needle.length - 1];
  return idx.original.slice(from, to + 1).replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* per-page line reconstruction                                         */
/* ------------------------------------------------------------------ */

/** The size that carries the most characters — i.e. the body text of this page. */
function dominant<T extends string | number>(weights: Map<T, number>): T | null {
  let best: T | null = null;
  let bestWeight = -1;
  for (const [k, w] of weights) {
    if (w > bestWeight) {
      best = k;
      bestWeight = w;
    }
  }
  return best;
}

function weigh<T extends string | number>(map: Map<T, number>, key: T, by: number) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function linesFromFrags(
  frags: Frag[],
  page: number,
  pageWidth: number,
  index: RepairIndex | null,
): Line[] {
  if (!frags.length) return [];

  const sizes = new Map<number, number>();
  const fonts = new Map<string, number>();
  for (const f of frags) {
    if (f.space) continue;
    weigh(sizes, f.size, f.text.trim().length);
    weigh(fonts, f.font, f.text.trim().length);
  }
  const bodySize = dominant(sizes) ?? 11;
  const bodyFont = dominant(fonts) ?? "";

  // Cluster by baseline. The tolerance comes from the page's body size rather
  // than the current fragment's, so a superscript marker stays on its own line.
  const tol = bodySize * 0.4;
  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x - b.x);

  const clusters: Frag[][] = [];
  let current: Frag[] = [];
  let refY = Infinity;
  for (const f of sorted) {
    if (!current.length || Math.abs(f.y - refY) <= tol) {
      if (!current.length) refY = f.y;
      current.push(f);
    } else {
      clusters.push(current);
      current = [f];
      refY = f.y;
    }
  }
  if (current.length) clusters.push(current);

  const out: Line[] = [];
  for (const cluster of clusters) {
    const inked = cluster.filter((f) => !f.space);
    if (!inked.length) continue;

    const bySize = new Map<number, number>();
    const byFont = new Map<string, number>();
    for (const f of inked) {
      weigh(bySize, f.size, f.text.trim().length);
      weigh(byFont, f.font, f.text.trim().length);
    }
    const size = dominant(bySize) ?? bodySize;
    const font = dominant(byFont) ?? "";

    const ordered = [...cluster].sort((a, b) => a.x - b.x);
    let text = "";
    let prevX1: number | null = null;
    for (const f of ordered) {
      if (f.space) {
        if (text && !/\s$/.test(text)) text += " ";
        continue;
      }
      // A small raised number next to body text is a footnote marker.
      const isMarker = f.size <= size * 0.8 && /^\d{1,3}$/.test(f.text.trim()) && cluster.length > 1;
      // The marker's own trailing space is the only thing separating it from the
      // next word, since a raised glyph sits flush against what follows.
      const piece = isMarker
        ? `${SUP_OPEN}${f.text.trim()}${SUP_CLOSE}${/\s$/.test(f.text) ? " " : ""}`
        : f.text;
      if (!piece.trim() && !text) continue;

      if (
        text &&
        prevX1 !== null &&
        f.x - prevX1 > f.size * 0.2 &&
        !/\s$/.test(text) &&
        !/^\s/.test(piece)
      ) {
        text += " ";
      }
      text += piece;
      prevX1 = f.x + f.w;
    }

    text = text.replace(/\s+/g, " ").trim();
    // A tracked-out title can be broken across several fragments, in which case
    // no single fragment looked spaced out but the assembled line does.
    if (looksLetterSpaced(text) && !text.includes(SUP_OPEN)) text = repair(text, index);
    if (!text) continue;

    const x0 = Math.min(...inked.map((f) => f.x));
    const x1 = Math.max(...inked.map((f) => f.x + f.w));
    const letters = text.replace(/[^\p{L}]/gu, "");

    out.push({
      page,
      y: Math.max(...inked.map((f) => f.y)),
      x0,
      x1,
      size,
      offFont: font !== bodyFont,
      text,
      caps: letters.length > 1 && letters === letters.toUpperCase(),
      center: (x0 + x1) / 2,
      pageWidth,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* document statistics                                                  */
/* ------------------------------------------------------------------ */

type Stats = {
  bodySize: number;
  leading: number;
  margins: number[];
  rightEdge: number;
  bodyWidth: number;
};

function computeStats(lines: Line[]): Stats {
  const sizes = new Map<number, number>();
  for (const l of lines) weigh(sizes, Math.round(l.size * 2) / 2, l.text.length);
  const bodySize = dominant(sizes) ?? 11;

  const isBody = (l: Line) => Math.abs(l.size - bodySize) < bodySize * 0.12;
  const body = lines.filter(isBody);

  // Leading: the most common baseline-to-baseline distance inside a page.
  const gaps = new Map<number, number>();
  for (let i = 1; i < body.length; i++) {
    const prev = body[i - 1];
    const cur = body[i];
    if (cur.page !== prev.page) continue;
    const d = Math.round((prev.y - cur.y) * 2) / 2;
    if (d > 0 && d < bodySize * 3) weigh(gaps, d, 1);
  }
  const leading = dominant(gaps) ?? bodySize * 1.3;

  // Left margins: books alternate verso/recto, so keep every column start that
  // shows up often rather than a single value.
  const starts = new Map<number, number>();
  for (const l of body) weigh(starts, Math.round(l.x0), 1);
  const margins = [...starts.entries()]
    .filter(([, n]) => n >= Math.max(4, body.length * 0.04))
    .map(([x]) => x)
    .sort((a, b) => a - b);

  const ends = body.map((l) => l.x1).sort((a, b) => a - b);
  const rightEdge = ends.length ? ends[Math.floor(ends.length * 0.9)] : 0;
  const bodyWidth = rightEdge - (margins[0] ?? 0);

  return {
    bodySize,
    leading,
    margins: margins.length ? margins : [Math.min(...body.map((l) => l.x0))],
    rightEdge,
    bodyWidth,
  };
}

function nearestMargin(x0: number, margins: number[]): number {
  let best = margins[0] ?? 0;
  for (const m of margins) if (Math.abs(x0 - m) < Math.abs(x0 - best)) best = m;
  return best;
}

/* ------------------------------------------------------------------ */
/* running heads and folios                                             */
/* ------------------------------------------------------------------ */

/**
 * Drop the page furniture: anything at the very top or bottom of a page whose
 * shape (digits blanked out) repeats across the book, plus bare page numbers.
 */
function dropFurniture(pages: Line[][]): void {
  // Whitespace goes first: a folio can be extracted as "12" or as "1 2", and both
  // have to collapse to the same shape or each digit count gets its own tally.
  const signature = (l: Line) =>
    l.text.replace(/\s+/g, "").replace(/\d+/g, "#").toLowerCase().slice(0, 60);

  const seen = new Map<string, number>();
  for (const lines of pages) {
    if (lines.length < 3) continue;
    for (const l of [lines[0], lines[lines.length - 1]]) {
      const s = signature(l);
      if (s) seen.set(s, (seen.get(s) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, pages.length * 0.08);
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p];
    if (lines.length < 3) continue;
    for (const edge of [0, lines.length - 1]) {
      const l = lines[edge];
      const repeats = (seen.get(signature(l)) ?? 0) >= threshold;
      const folio = /^[\s\d]+$/.test(l.text) || /^[ivxlcdm\s]+$/i.test(l.text);
      if (repeats || folio) lines[edge] = { ...l, text: "" };
    }
    pages[p] = lines.filter((l) => l.text);
  }
}

/* ------------------------------------------------------------------ */
/* de-hyphenation                                                       */
/* ------------------------------------------------------------------ */

/**
 * A line ending in "-" is usually a word split by the typesetter, but sometimes
 * a genuine compound ("self-sabotage"). The book itself is the dictionary: look
 * for whichever form occurs elsewhere in the same document.
 */
function buildVocab(lines: Line[]): Set<string> {
  const vocab = new Set<string>();
  for (const l of lines) {
    for (const token of l.text.toLowerCase().split(/[^\p{L}’'-]+/u)) {
      const t = token.replace(/^[-'’]+|[-'’]+$/g, "");
      if (t.length > 1) vocab.add(t);
    }
  }
  return vocab;
}

function joinLines(parts: string[], vocab: Set<string>): string {
  let out = "";
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }

    const broken = /(\p{L})[-‐‑]$/u.exec(out);
    if (broken && /^\p{Ll}/u.test(piece)) {
      const left = out.slice(0, -1);
      const leftWord = (/[\p{L}’'-]+$/u.exec(left)?.[0] ?? "").toLowerCase();
      const rightWord = (/^[\p{L}’'-]+/u.exec(piece)?.[0] ?? "").toLowerCase();
      const hyphenated = vocab.has(`${leftWord}-${rightWord}`);
      const fused = vocab.has(`${leftWord}${rightWord}`);
      out = hyphenated && !fused ? `${out}${piece}` : `${left}${piece}`;
    } else {
      out += ` ${piece}`;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* block assembly                                                       */
/* ------------------------------------------------------------------ */

type Block = { tag: "p" | "h2" | "blockquote"; text: string; size: number; heading: boolean };

const NUMBER =
  String.raw`\d+|[ivxlcdm]+\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|` +
  String.raw`thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty`;

// "Act", "Part" and "Book" are ordinary words, so they only count as a division
// marker when a number follows — otherwise "ACT ON PURPOSE" starts a chapter.
const CHAPTER_RE = new RegExp(
  String.raw`^\s*(?:chapter\b` +
    String.raw`|(?:part|book|section|act|canto|volume)\s+(?:${NUMBER})\b` +
    String.raw`|(?:prologue|epilogue|introduction|conclusion|appendix|foreword|preface|afterword|interlude)\b)`,
  "i",
);

function isCentered(line: Line, stats: Stats): boolean {
  return (
    Math.abs(line.center - line.pageWidth / 2) < line.pageWidth * 0.07 &&
    line.x1 - line.x0 < stats.bodyWidth * 0.9
  );
}

/** Longest a run of display type can be and still be read as a heading. */
const HEADING_MAX = 110;

function headingScore(line: Line, prevGap: number, stats: Stats): number {
  if (line.text.length > HEADING_MAX) return 0;
  if (/[,;:]$/.test(line.text)) return 0;

  const centered = isCentered(line, stats);

  let score = 0.5;
  if (line.size >= stats.bodySize * 1.15) score += 2;
  if (line.offFont) score += 1;
  if (line.caps) score += 1;
  if (centered) score += 1;
  if (prevGap > stats.leading * 1.6) score += 1;
  if (CHAPTER_RE.test(line.text)) score += 1;
  return score;
}

type Marked = Line & { heading: boolean };

function toBlocks(pages: Line[][], stats: Stats, vocab: Set<string>): Block[] {
  const flat = pages.flat();

  // Which paragraphing convention does this book use? Extra leading and first
  // line indents are both common; only fall back to "a short line ends the
  // paragraph" when neither shows up, since that rule misfires on justified text.
  let gapBreaks = 0;
  let indentBreaks = 0;
  for (let i = 1; i < flat.length; i++) {
    const prev = flat[i - 1];
    const cur = flat[i];
    if (cur.page !== prev.page) continue;
    if (prev.y - cur.y > stats.leading * 1.45) gapBreaks++;
    if (
      !isCentered(cur, stats) &&
      cur.x0 - nearestMargin(cur.x0, stats.margins) > stats.bodySize * 0.6
    ) {
      indentBreaks++;
    }
  }
  const useShortLineRule = gapBreaks + indentBreaks < flat.length / 40;

  const blocks: Block[] = [];
  let buffer: Marked[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const text = joinLines(buffer.map((l) => l.text), vocab);
    if (text) {
      // Display type running past a sentence or two is a pull quote, not a
      // heading — each of its lines looks like one, but the whole does not.
      const display = buffer[0].heading;
      const heading = display && text.length <= HEADING_MAX;
      const inset =
        !heading &&
        (display ||
          buffer.every(
            (l) =>
              l.x0 - nearestMargin(l.x0, stats.margins) > stats.bodySize * 0.9 &&
              l.x1 < stats.rightEdge - stats.bodySize * 0.9,
          ));
      blocks.push({
        tag: heading ? "h2" : inset ? "blockquote" : "p",
        text,
        size: buffer[0].size,
        heading,
      });
    }
    buffer = [];
  };

  const marked: Marked[] = flat.map((l, i) => {
    const prev = flat[i - 1];
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    return { ...l, heading: headingScore(l, gap, stats) >= 3 };
  });

  for (let i = 0; i < marked.length; i++) {
    const line = marked[i];
    const prev = i > 0 ? marked[i - 1] : null;

    let breakHere = !prev;
    if (prev) {
      if (Boolean(prev.heading) !== Boolean(line.heading)) {
        breakHere = true;
      } else if (line.heading) {
        // Consecutive display lines at a comparable size are one heading broken
        // over several lines. Title pages set them very loose, hence the wide
        // gap allowance — nothing but whitespace can sit between them anyway.
        breakHere =
          line.page !== prev.page ||
          Math.abs(line.size - prev.size) > Math.max(prev.size, line.size) * 0.15 ||
          prev.y - line.y > stats.leading * 4;
      } else if (line.page !== prev.page) {
        // Across a page turn, a full-measure last line means the paragraph runs on.
        breakHere = prev.x1 < stats.rightEdge - stats.bodyWidth * 0.06;
      } else {
        const gap = prev.y - line.y;
        // Centred lines sit far from the margin without being a new paragraph.
        const indent = isCentered(line, stats)
          ? 0
          : line.x0 - nearestMargin(line.x0, stats.margins);
        breakHere =
          gap > stats.leading * 1.45 ||
          indent > stats.bodySize * 0.6 ||
          (useShortLineRule && prev.x1 < stats.rightEdge - stats.bodySize * 1.2);
      }
    }

    if (breakHere) flush();
    buffer.push(line);
  }
  flush();

  return blocks;
}

/* ------------------------------------------------------------------ */
/* chapters                                                             */
/* ------------------------------------------------------------------ */

function renderBlock(b: Block): string {
  const html = escapeHtml(b.text)
    .replace(new RegExp(`${SUP_OPEN}(\\d+)${SUP_CLOSE}`, "g"), "<sup>$1</sup>")
    .replace(new RegExp(`[${SUP_OPEN}${SUP_CLOSE}]`, "g"), "");
  return `<${b.tag}>${html}</${b.tag}>`;
}

function plainLength(blocks: Block[]): number {
  return blocks.reduce((n, b) => n + b.text.length, 0);
}

function chaptersFromBlocks(blocks: Block[], stats: Stats): ParsedChapter[] {
  const displaySize = Math.max(
    stats.bodySize,
    ...blocks.filter((b) => b.heading).map((b) => b.size),
  );
  const hasDisplay = displaySize > stats.bodySize * 1.1;

  const startsChapter = (b: Block) =>
    b.heading && ((hasDisplay && b.size >= displaySize - 0.6) || CHAPTER_RE.test(b.text));

  // Only chop long stretches into pieces when the book gave us nothing to split
  // on — otherwise real chapters get an arbitrary "(cont.)" tail.
  const hasChapters = blocks.some(startsChapter);

  const chapters: ParsedChapter[] = [];
  let title = "";
  let body: Block[] = [];

  const push = () => {
    if (plainLength(body) < 40) return;
    chapters.push({
      title: (title || `Section ${chapters.length + 1}`).slice(0, 120),
      html: body.map(renderBlock).join("\n"),
    });
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (startsChapter(b)) {
      push();
      body = [];
      title = b.text;
      // "CHAPTER 1" followed by the actual title is two lines of one heading.
      const next = blocks[i + 1];
      if (next?.heading && CHAPTER_RE.test(b.text) && !CHAPTER_RE.test(next.text)) {
        title = `${b.text} — ${next.text}`;
        i++;
      }
      continue;
    }

    body.push(b);
    // A book with no headings at all still has to paginate.
    if (!hasChapters && body.length >= 120) {
      push();
      title = title ? `${title.replace(/ \(cont\.\)$/, "")} (cont.)` : "";
      body = [];
    }
  }
  push();

  if (!chapters.length && blocks.length) {
    chapters.push({ title: "Beginning", html: blocks.map(renderBlock).join("\n") });
  }
  return chapters;
}

/* ------------------------------------------------------------------ */
/* entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * pdf.js reaches for `DOMMatrix` as it loads, and on some Node hosts — Vercel's
 * among them, though not a local Node of the same version — it is not there, so
 * the import throws before any of it can be used.
 *
 * Nothing below renders anything: this reads the geometry out of the text
 * layer, and the matrix maths it does use is pdf.js's own. So the class only
 * has to exist for the module to finish loading. It is deliberately not an
 * implementation — a wrong one would be worse than an absent one — and it is
 * only installed when the platform has not supplied the real thing.
 */
export function ensureDomMatrix(): void {
  const g = globalThis as { DOMMatrix?: unknown };
  if (g.DOMMatrix) return;

  g.DOMMatrix = class {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;

    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
  };
}

export async function parsePdf(buf: Buffer, fallbackTitle: string): Promise<ParsedBook> {
  ensureDomMatrix();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true });
  const doc = await task.promise;

  const pages: Line[][] = [];
  let info: { Title?: string; Author?: string } = {};
  try {
    info = await doc
      .getMetadata()
      .then((m) => (m.info ?? {}) as { Title?: string; Author?: string })
      .catch(() => ({}));

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const raw: Frag[] = [];
      let spaced = false;
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const t = item.transform as number[];
        // Skip rotated runs; the reconstruction assumes horizontal baselines.
        if (Math.abs(t[1]) > Math.abs(t[0]) * 0.5) continue;
        const space = !item.str.trim();
        if (!space && looksLetterSpaced(item.str)) spaced = true;
        raw.push({
          text: item.str,
          x: t[4],
          y: t[5],
          w: item.width,
          size: item.height || Math.abs(t[3]) || Math.abs(t[0]),
          font: item.fontName ?? "",
          space,
        });
      }

      // Only pay for the operator list on pages that actually need repairing.
      let index: RepairIndex | null = null;
      if (spaced) {
        const ops = await page.getOperatorList();
        index = buildRepairIndex(ops, pdfjs.OPS.showText, pdfjs.OPS.showSpacedText);
      }
      for (const f of raw) {
        if (looksLetterSpaced(f.text)) f.text = repair(f.text, index);
      }

      pages.push(linesFromFrags(raw, n, viewport.width, index));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  const total = pages.flat().reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
  if (total < 200) {
    throw new Error(
      "No selectable text found in this PDF — it is probably a scan. Scanned PDFs need OCR, which this reader does not do.",
    );
  }

  dropFurniture(pages);

  const flat = pages.flat();
  const stats = computeStats(flat);
  const blocks = toBlocks(pages, stats, buildVocab(flat));
  const chapters = chaptersFromBlocks(blocks, stats);

  if (!chapters.length) throw new Error("This PDF contains no readable text.");

  return {
    title: (info.Title ?? "").trim() || fallbackTitle,
    author: (info.Author ?? "").trim(),
    language: "en",
    chapters,
  };
}
