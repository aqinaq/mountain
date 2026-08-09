/** Client-side helpers for making rendered prose word-addressable. */

const WORD_RE = /^[\p{L}\p{M}'’‐-]+$/u;
const SPLIT_RE = /([\p{L}\p{M}'’‐-]+)/u;

/**
 * Wrap every word in the subtree in a `<span class="w">` so each one is its own
 * tap target. Idempotent: spans we already made are skipped.
 */
export function wrapWords(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.classList.contains("w")) return NodeFilter.FILTER_REJECT;
      if (!/\p{L}/u.test(node.nodeValue ?? "")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);

  for (const node of targets) {
    const parts = (node.nodeValue ?? "").split(SPLIT_RE);
    if (parts.length < 2) continue;

    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      if (WORD_RE.test(part) && /\p{L}/u.test(part)) {
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = part;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

const BLOCK_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "DD", "DT", "PRE"]);

function closestBlock(el: Element, root: HTMLElement): HTMLElement {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return root;
}

/** Character offset of `el` within its containing block's text. */
function offsetInBlock(block: HTMLElement, el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(block);
  try {
    range.setEnd(el, 0);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/** Slice out the sentence covering `offset`. Abbreviation-naive but reliable enough. */
export function sentenceAt(text: string, offset: number): string {
  const boundary = /[.!?…]["'’”»)\]]?(?:\s+|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end > offset) {
      return text.slice(start, match.index + match[0].trimEnd().length).trim();
    }
    start = end;
  }
  return text.slice(start).trim();
}

/** The readable blocks of a chapter, in reading order. */
export function blocksOf(root: HTMLElement): HTMLElement[] {
  const selector = [...BLOCK_TAGS].map((t) => t.toLowerCase()).join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => (el.textContent ?? "").trim().length > 0,
  );
}

/**
 * Where each tappable word starts within its block's text, so a speech
 * synthesiser's character offsets can be turned back into elements to highlight.
 */
export function wordOffsets(block: HTMLElement): { start: number; end: number; el: HTMLElement }[] {
  const out: { start: number; end: number; el: HTMLElement }[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = (node.nodeValue ?? "").length;
    const parent = node.parentElement;
    if (parent?.classList.contains("w")) {
      out.push({ start: offset, end: offset + len, el: parent });
    }
    offset += len;
  }

  return out;
}

/** The sentence a tapped word sits in, for context in the translation popup. */
export function sentenceForElement(root: HTMLElement, el: Element): string {
  const block = closestBlock(el, root);
  const text = block.textContent ?? "";
  if (text.length <= 400) return text.trim();
  return sentenceAt(text, offsetInBlock(block, el)) || text.slice(0, 400).trim();
}
