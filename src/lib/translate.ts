import { getDb } from "./db";

export type DictionarySense = {
  partOfSpeech: string;
  definition: string;
  definitionKk?: string;
  example?: string;
  synonyms: string[];
};

export type TranslateResult = {
  text: string;
  kind: "word" | "phrase";
  target: string;
  translation: string;
  provider: string;
  phonetic?: string;
  senses: DictionarySense[];
  /** Set when every provider failed, so the UI can say so instead of showing blank. */
  error?: string;

  /* Added by the API route rather than the translator, and never cached: they
     depend on your own word lists and on which book you are reading. */
  lemma?: string;
  known?: boolean;
  occurrences?: number;
};

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function cacheKey(text: string, target: string) {
  return `${target}::${text.toLowerCase()}`;
}

async function readCache(text: string, target: string): Promise<TranslateResult | null> {
  const db = await getDb();
  const row = await db.get<{ payload: string; created_at: number }>(
    "SELECT payload, created_at FROM translation_cache WHERE key = ?",
    cacheKey(text, target),
  );
  if (!row) return null;
  if (Date.now() - row.created_at > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.payload) as TranslateResult;
  } catch {
    return null;
  }
}

async function writeCache(text: string, target: string, result: TranslateResult): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO translation_cache (key, payload, created_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    cacheKey(text, target),
    JSON.stringify(result),
    Date.now(),
  );
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some free endpoints reject requests with no UA.
        "User-Agent": "Mozilla/5.0 (compatible; MountainReader/1.0)",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Machine-translation providers. Tried in order; first success wins.
 * Each returns null on failure so the chain can fall through.
 * ------------------------------------------------------------------ */

type Provider = { name: string; translate: (text: string, target: string) => Promise<string | null> };

const googleWeb: Provider = {
  name: "google",
  async translate(text, target) {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en" +
      `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    const data = (await fetchJson(url)) as unknown;
    // Shape: [[["translated","source",...], ...], ...]
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const out = (data[0] as unknown[])
      .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
      .join("");
    return out.trim() || null;
  },
};

const myMemory: Provider = {
  name: "mymemory",
  async translate(text, target) {
    // MyMemory caps a single query at 500 bytes.
    if (Buffer.byteLength(text) > 480) return null;
    const url =
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
      `&langpair=${encodeURIComponent(`en|${target}`)}`;
    const data = (await fetchJson(url)) as { responseData?: { translatedText?: string } };
    const out = data?.responseData?.translatedText?.trim();
    if (!out) return null;
    // MyMemory reports quota problems in the payload rather than the status code.
    if (/^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID)/i.test(out)) return null;
    return out;
  },
};

const PROVIDERS: Provider[] = [googleWeb, myMemory];

async function machineTranslate(
  text: string,
  target: string,
): Promise<{ translation: string; provider: string } | null> {
  // These public services have very different latency and rate-limit profiles.
  // Start both together so a throttled primary does not add its full delay
  // before the fallback even begins.
  try {
    return await Promise.any(
      PROVIDERS.map(async (p) => {
        const translation = await p.translate(text, target);
        if (!translation) throw new Error(`${p.name} returned no translation`);
        return { translation, provider: p.name };
      }),
    );
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * English dictionary lookup — this is the "explanation" half.
 * ------------------------------------------------------------------ */

type DictApiEntry = {
  phonetic?: string;
  phonetics?: { text?: string }[];
  meanings?: {
    partOfSpeech?: string;
    definitions?: { definition?: string; example?: string; synonyms?: string[] }[];
    synonyms?: string[];
  }[];
};

async function lookupDictionary(word: string): Promise<{ phonetic?: string; senses: DictionarySense[] }> {
  try {
    const data = (await fetchJson(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      1500,
    )) as DictApiEntry[];
    if (!Array.isArray(data) || !data.length) return { senses: [] };

    const phonetic =
      data[0].phonetic || data[0].phonetics?.find((p) => p.text)?.text || undefined;

    const senses: DictionarySense[] = [];
    for (const entry of data) {
      for (const meaning of entry.meanings ?? []) {
        for (const def of (meaning.definitions ?? []).slice(0, 2)) {
          if (!def.definition) continue;
          senses.push({
            partOfSpeech: meaning.partOfSpeech ?? "",
            definition: def.definition,
            example: def.example,
            synonyms: (def.synonyms ?? meaning.synonyms ?? []).slice(0, 5),
          });
          if (senses.length >= 4) return { phonetic, senses };
        }
      }
    }
    return { phonetic, senses };
  } catch {
    return { senses: [] };
  }
}

/** A "word" is a single token — those get the full dictionary treatment. */
export function classify(text: string): "word" | "phrase" {
  return /^[\p{L}'’-]+$/u.test(text.trim()) ? "word" : "phrase";
}

export async function translate(rawText: string, target: string): Promise<TranslateResult> {
  const text = rawText.trim().replace(/\s+/g, " ").slice(0, 1200);
  const kind = classify(text);

  const cached = await readCache(text, target);
  if (cached) return cached;

  const [mt, dict] = await Promise.all([
    machineTranslate(text, target),
    kind === "word" ? lookupDictionary(text.replace(/[’']s$/i, "")) : Promise.resolve({ senses: [] }),
  ]);

  const result: TranslateResult = {
    text,
    kind,
    target,
    translation: mt?.translation ?? "",
    provider: mt?.provider ?? "none",
    phonetic: "phonetic" in dict ? dict.phonetic : undefined,
    senses: dict.senses,
    error: mt ? undefined : "Translation services are unreachable right now.",
  };

  if (mt || dict.senses.length) await writeCache(text, target, result);
  return result;
}
