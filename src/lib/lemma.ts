/**
 * A small rule-based English lemmatiser. No dictionary download, no dependency —
 * an irregular-form table plus suffix rules, which is enough to stop "ran",
 * "running" and "runs" being counted as three different words.
 *
 * Runs on both sides: the server uses it to index a book, the reader uses it to
 * decide which words to dim as already known.
 *
 * Suffix stripping is ambiguous — "loved" could stem to "lov" or "love" — so
 * `lemma()` produces candidates in priority order and, when it is handed a
 * lexicon, returns the first candidate that actually appears in it. The book's
 * own surface forms make a serviceable lexicon: a text with "loved" in it
 * almost always has "love" somewhere too.
 */

/** Verbs whose past/participle forms no rule will ever recover. */
const IRREGULAR: Record<string, string> = {
  // be / have / do
  am: "be", is: "be", are: "be", was: "be", were: "be", been: "be", being: "be",
  has: "have", had: "have", having: "have",
  does: "do", did: "do", done: "do", doing: "do",
  // common strong verbs
  went: "go", gone: "go", goes: "go",
  said: "say", says: "say",
  made: "make", making: "make",
  came: "come", coming: "come",
  took: "take", taken: "take", taking: "take",
  saw: "see", seen: "see", seeing: "see",
  knew: "know", known: "know",
  got: "get", gotten: "get", getting: "get",
  gave: "give", given: "give", giving: "give",
  found: "find", finding: "find",
  thought: "think", told: "tell", became: "become", becoming: "become",
  left: "leave", leaving: "leave", felt: "feel", put: "put", putting: "put",
  brought: "bring", began: "begin", begun: "begin", beginning: "begin",
  kept: "keep", keeping: "keep", held: "hold", holding: "hold",
  wrote: "write", written: "write", writing: "write",
  stood: "stand", standing: "stand", heard: "hear", hearing: "hear",
  let: "let", letting: "let", meant: "mean", meaning: "mean",
  met: "meet", meeting: "meet", ran: "run", running: "run",
  paid: "pay", paying: "pay", sat: "sit", sitting: "sit",
  spoke: "speak", spoken: "speak", speaking: "speak",
  lay: "lie", lain: "lie", lying: "lie", led: "lead", leading: "lead",
  grew: "grow", grown: "grow", lost: "lose", losing: "lose",
  fell: "fall", fallen: "fall", falling: "fall", sent: "send", sending: "send",
  built: "build", building: "build", understood: "understand",
  drew: "draw", drawn: "draw", broke: "break", broken: "break", breaking: "break",
  spent: "spend", spending: "spend", cut: "cut", cutting: "cut",
  rose: "rise", risen: "rise", rising: "rise", drove: "drive", driven: "drive", driving: "drive",
  bought: "buy", buying: "buy", wore: "wear", worn: "wear", wearing: "wear",
  chose: "choose", chosen: "choose", choosing: "choose",
  sought: "seek", seeking: "seek", threw: "throw", thrown: "throw", throwing: "throw",
  caught: "catch", catching: "catch", taught: "teach", teaching: "teach",
  fought: "fight", fighting: "fight", bore: "bear", borne: "bear", bearing: "bear",
  sold: "sell", selling: "sell", ate: "eat", eaten: "eat", eating: "eat",
  drank: "drink", drunk: "drink", drinking: "drink",
  rode: "ride", ridden: "ride", riding: "ride",
  sang: "sing", sung: "sing", singing: "sing",
  swam: "swim", swum: "swim", swimming: "swim",
  woke: "wake", woken: "wake", waking: "wake",
  slept: "sleep", sleeping: "sleep", flew: "fly", flown: "fly", flying: "fly",
  hung: "hang", hanging: "hang", shone: "shine", shining: "shine",
  shook: "shake", shaken: "shake", shaking: "shake",
  struck: "strike", striking: "strike", stuck: "stick", sticking: "stick",
  swore: "swear", sworn: "swear", swearing: "swear",
  tore: "tear", torn: "tear", tearing: "tear",
  hid: "hide", hidden: "hide", hiding: "hide",
  bound: "bind", binding: "bind", bit: "bite", bitten: "bite", biting: "bite",
  blew: "blow", blown: "blow", blowing: "blow",
  crept: "creep", creeping: "creep", dealt: "deal", dealing: "deal",
  dug: "dig", digging: "dig",
  fed: "feed", feeding: "feed", fled: "flee", fleeing: "flee",
  forgot: "forget", forgotten: "forget", forgetting: "forget",
  forgave: "forgive", forgiven: "forgive", froze: "freeze", frozen: "freeze", freezing: "freeze",
  ground: "grind", grinding: "grind", knelt: "kneel", kneeling: "kneel",
  laid: "lay", laying: "lay", leapt: "leap", learnt: "learn",
  lent: "lend", lending: "lend", lit: "light", lighting: "light",
  rang: "ring", rung: "ring", ringing: "ring",
  sank: "sink", sunk: "sink", sinking: "sink",
  shot: "shoot", shooting: "shoot", shut: "shut", shutting: "shut",
  slid: "slide", sliding: "slide", spread: "spread", spreading: "spread",
  sprang: "spring", sprung: "spring", springing: "spring",
  stole: "steal", stolen: "steal", stealing: "steal",
  strode: "stride", striding: "stride", swept: "sweep", sweeping: "sweep",
  swung: "swing", swinging: "swing", wept: "weep", weeping: "weep",
  won: "win", winning: "win", wound: "wind", winding: "wind",
  withdrew: "withdraw", withdrawn: "withdraw",
  // irregular plurals
  children: "child", men: "man", women: "woman", people: "person",
  feet: "foot", teeth: "tooth", geese: "goose", mice: "mouse", lice: "louse",
  oxen: "ox", knives: "knife", wives: "wife", lives: "life", leaves: "leaf",
  wolves: "wolf", halves: "half", shelves: "shelf", thieves: "thief",
  loaves: "loaf", selves: "self", calves: "calf", elves: "elf", scarves: "scarf",
  // pronouns and determiners, so "him"/"his" collapse onto one entry
  an: "a", him: "he", his: "he", himself: "he", her: "she", hers: "she",
  herself: "she", them: "they", their: "they", theirs: "they", themselves: "they",
  us: "we", our: "we", ours: "we", ourselves: "we",
  me: "i", my: "i", mine: "i", myself: "i",
  your: "you", yours: "you", yourself: "you", yourselves: "you",
  its: "it", itself: "it", these: "this", those: "that",
  // comparatives that no suffix rule should touch
  better: "good", best: "good", worse: "bad", worst: "bad",
  more: "much", most: "much", less: "little", least: "little",
  further: "far", furthest: "far", farther: "far", farthest: "far",
};

/** Nouns that end in -s but are not plurals; the -s rule would mangle them. */
const INVARIANT = new Set([
  "news", "series", "species", "means", "politics", "mathematics", "physics",
  "economics", "ethics", "athletics", "gymnastics", "statistics", "clothes",
  "scissors", "trousers", "glasses", "riches", "thanks", "lens", "gas", "yes",
  "always", "perhaps", "unless", "across", "towards", "besides", "sometimes",
  "themselves", "ourselves", "yourselves", "everyone", "someone", "anyone",
]);

/** Doubling a final consonant is only undone for letters that actually double. */
const DOUBLES = new Set(["b", "d", "g", "l", "m", "n", "p", "r", "t"]);

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

function hasVowel(s: string): boolean {
  for (const ch of s) if (VOWELS.has(ch) || ch === "y") return true;
  return false;
}

/** Undo a doubled final consonant: "stopp" → "stop", but leave "kiss" alone. */
function undouble(stem: string): string | null {
  const n = stem.length;
  if (n < 3) return null;
  const last = stem[n - 1];
  if (last !== stem[n - 2]) return null;
  return DOUBLES.has(last) ? stem.slice(0, -1) : null;
}

/**
 * Every plausible base form of `word`, best guess first. Always includes the
 * word itself as the final fallback, so this never returns an empty list.
 */
/** The auxiliaries left unrecognisable once "n't" is peeled off. */
const CLIPPED_AUX: Record<string, string> = {
  wo: "will",
  ca: "can",
  sha: "shall",
  ai: "be",
};

/**
 * Reduce a contraction to its head word: "don't" → "do", "you're" → "you".
 * Without this every contraction in a book is a word you can never learn,
 * because it never matches anything in the dictionary or your word lists.
 */
function uncontract(w: string): string {
  const m = /^(\p{L}+)['’](s|re|ve|ll|d|m|t)$/u.exec(w);
  if (!m) return w;

  if (m[2] !== "t") return m[1];

  const stem = m[1].replace(/n$/, "");
  return CLIPPED_AUX[stem] ?? stem;
}

export function lemmaCandidates(word: string): string[] {
  const w = uncontract(word.toLowerCase().replace(/^[’']|[’']$/g, ""));

  // Before the length guard: "is", "am", "his" and "me" are all short.
  const irregular = IRREGULAR[w];
  if (irregular) return [irregular];
  if (w.length < 3 || INVARIANT.has(w)) return [w];

  const out: string[] = [];
  const add = (c: string | null | undefined) => {
    if (c && c.length >= 2 && hasVowel(c) && !out.includes(c)) out.push(c);
  };

  // ---- plurals and third-person singular ----
  if (w.endsWith("ies") && w.length > 4) add(`${w.slice(0, -3)}y`);
  if (/(ss|sh|ch|x|z|o)es$/.test(w)) add(w.slice(0, -2));
  if (w.endsWith("ves") && w.length > 4) {
    add(`${w.slice(0, -3)}f`);
    add(`${w.slice(0, -3)}fe`);
  }
  if (w.endsWith("s") && !/(ss|us|is|as)$/.test(w)) add(w.slice(0, -1));

  // ---- past tense / participle ----
  if (w.endsWith("ied") && w.length > 4) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("ed") && w.length > 3) {
    const stem = w.slice(0, -2);
    add(undouble(stem));
    add(stem);
    add(`${stem}e`); // loved → love
  }

  // ---- progressive ----
  if (w.endsWith("ing") && w.length > 4) {
    const stem = w.slice(0, -3);
    add(undouble(stem));
    add(`${stem}e`); // writing → write
    add(stem);
  }

  // ---- adverbs and a couple of safe derivations ----
  if (w.endsWith("ily") && w.length > 4) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("ly") && w.length > 4) add(w.slice(0, -2));

  add(w);
  return out;
}

/**
 * The base form of `word`. Pass `known` — a set of forms that really occur, such
 * as every distinct token in the book — and the first candidate found in it
 * wins; without one the highest-priority guess is used.
 */
export function lemma(word: string, known?: ReadonlySet<string>): string {
  const candidates = lemmaCandidates(word);
  if (known) {
    for (const c of candidates) if (known.has(c)) return c;
  }
  return candidates[0] ?? word.toLowerCase();
}

const TOKEN_RE = /[\p{L}][\p{L}\p{M}'’-]*/gu;

/** Every word-shaped token in a piece of text, lowercased. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0].toLowerCase().replace(/^[-'’]+|[-'’]+$/g, "");
    if (t.length > 1 || t === "a" || t === "i") out.push(t);
  }
  return out;
}
