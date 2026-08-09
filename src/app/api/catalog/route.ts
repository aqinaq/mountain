import { NextResponse } from "next/server";
import { searchCatalog } from "@/lib/books";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1") || 1;

  try {
    return NextResponse.json(await searchCatalog(q, page));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Catalog search failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
