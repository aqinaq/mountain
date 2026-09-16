/**
 * The Project Gutenberg catalogue, as seen through gutendex.
 *
 * This searches from the reader's own browser rather than from the server, and
 * that is not a preference: gutendex answers a datacentre address with 403,
 * which is what every deployed search got, while the same request from a
 * laptop is let through. It allows any origin, so the browser is free to ask
 * it directly, and the request then carries the reader's address instead.
 *
 * Downloading the book itself stays on the server — gutenberg.org sends no
 * CORS headers at all, so a browser cannot fetch it, and gutenberg.org has no
 * objection to the deployment.
 *
 * Deliberately free of anything Node-only, because both sides import it.
 */

export type CatalogBook = {
  id: number;
  title: string;
  authors: string;
  languages: string[];
  subjects: string[];
  downloadCount: number;
  coverUrl?: string;
  epubUrl?: string;
  textUrl?: string;
};

type GutendexBook = {
  id: number;
  title: string;
  authors?: { name?: string }[];
  languages?: string[];
  subjects?: string[];
  download_count?: number;
  formats?: Record<string, string>;
};

export function mapGutendex(b: GutendexBook): CatalogBook {
  const f = b.formats ?? {};
  const pick = (test: (k: string) => boolean) =>
    Object.entries(f).find(([k, v]) => test(k) && !v.endsWith(".zip"))?.[1];

  return {
    id: b.id,
    title: b.title,
    authors: (b.authors ?? []).map((a) => a.name).filter(Boolean).join(", ") || "Unknown",
    languages: b.languages ?? [],
    subjects: (b.subjects ?? []).slice(0, 4),
    downloadCount: b.download_count ?? 0,
    coverUrl: pick((k) => k.startsWith("image/")),
    epubUrl: pick((k) => k.includes("epub")),
    textUrl: pick((k) => k.startsWith("text/plain")),
  };
}

export async function searchCatalog(
  query: string,
  page: number,
): Promise<{ books: CatalogBook[]; hasMore: boolean }> {
  const url = new URL("https://gutendex.com/books");
  url.searchParams.set("languages", "en");
  url.searchParams.set("page", String(Math.max(1, page)));
  if (query.trim()) url.searchParams.set("search", query.trim());
  else url.searchParams.set("sort", "popular");

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12000) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error("The Gutenberg catalog did not respond. Please try again.");
    }
    throw new Error("The Gutenberg catalog could not be reached. Please try again.");
  }
  if (!res.ok) throw new Error(`Gutenberg catalog is unavailable (HTTP ${res.status}).`);
  const data = (await res.json()) as { results?: GutendexBook[]; next?: string | null };

  return { books: (data.results ?? []).map(mapGutendex), hasMore: Boolean(data.next) };
}

/**
 * Whether a download address is one we are willing to fetch on the reader's
 * behalf.
 *
 * The addresses now arrive from the browser rather than from a lookup the
 * server did itself, which means they are input. Without this the import route
 * would fetch any URL it was handed, from inside the deployment — the ordinary
 * shape of a server-side request forgery. Only Gutenberg is served.
 */
export function isGutenbergUrl(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    const { protocol, hostname } = new URL(candidate);
    return protocol === "https:" && (hostname === "gutenberg.org" || hostname.endsWith(".gutenberg.org"));
  } catch {
    return false;
  }
}
