import { NextResponse } from "next/server";
import { ingestBuffer, saveBook } from "@/lib/books";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Vercel refuses a request body over 4.5 MB before this handler ever runs, and
 * what it returns is a platform error page rather than anything the uploader
 * can explain. So the limit is set below theirs, and the reader gets a sentence
 * about the file instead of a wall of nothing.
 */
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error:
          `That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ` +
          `${MAX_BYTES / 1048576} MB.`,
      },
      { status: 413 },
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { parsed, ext } = await ingestBuffer(buffer, file.name);
    const id = await saveBook({
      userId,
      parsed,
      source: "upload",
      original: { buffer, ext },
      titleOverride: String(form.get("title") ?? "") || undefined,
      authorOverride: String(form.get("author") ?? "") || undefined,
    });
    return NextResponse.json({ id, title: parsed.title, chapters: parsed.chapters.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read that file.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
