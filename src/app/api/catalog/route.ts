import { NextResponse } from "next/server";
import { parseGutenbergOpds } from "@/lib/gutenberg-opds";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const requested = new URL(req.url);
  const query = requested.searchParams.get("query")?.trim().slice(0, 200) ?? "";
  const page = Math.max(1, Math.min(100, Number(requested.searchParams.get("page")) || 1));

  const catalogUrl = new URL("https://www.gutenberg.org/ebooks/search.opds/");
  catalogUrl.searchParams.set("sort_order", "downloads");
  catalogUrl.searchParams.set("start_index", String((page - 1) * 25 + 1));
  if (query) catalogUrl.searchParams.set("query", query);

  try {
    const res = await fetch(catalogUrl, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MountainReader/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return NextResponse.json(parseGutenbergOpds(await res.text()));
  } catch (err) {
    console.error("Catalog request failed:", err);
    return NextResponse.json(
      { error: "The Gutenberg catalog could not be reached. Please try again." },
      { status: 502 },
    );
  }
}

