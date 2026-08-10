import { NextResponse } from "next/server";
import { importFromGutenberg } from "@/lib/books";
import { isGutenbergUrl, type CatalogBook } from "@/lib/gutendex";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Import a catalogue book the browser has already looked up.
 *
 * The lookup cannot happen here: gutendex answers this deployment with 403 and
 * the reader's own browser with 200, so the browser does that half and hands
 * over what it found. Fetching the book itself stays here, because
 * gutenberg.org sends no CORS headers and a browser cannot reach it.
 *
 * That makes the download addresses input rather than something we looked up,
 * which is the one part that has to be checked.
 */
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as Partial<CatalogBook>;

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A valid Gutenberg book id is required." }, { status: 400 });
  }

  const epubUrl = isGutenbergUrl(body.epubUrl) ? body.epubUrl : undefined;
  const textUrl = isGutenbergUrl(body.textUrl) ? body.textUrl : undefined;
  if (!epubUrl && !textUrl) {
    return NextResponse.json(
      { error: "This title has no downloadable EPUB or text edition." },
      { status: 400 },
    );
  }

  const meta: CatalogBook = {
    id,
    title: String(body.title ?? "").slice(0, 300) || `Gutenberg ${id}`,
    authors: String(body.authors ?? "").slice(0, 300) || "Unknown",
    languages: Array.isArray(body.languages) ? body.languages.slice(0, 5).map(String) : [],
    subjects: [],
    downloadCount: 0,
    // Shown as an image, so it is checked for the same reason the downloads are.
    coverUrl: isGutenbergUrl(body.coverUrl) ? body.coverUrl : undefined,
    epubUrl,
    textUrl,
  };

  try {
    return NextResponse.json({ id: await importFromGutenberg(userId, meta) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
