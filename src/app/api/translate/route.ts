import { NextResponse } from "next/server";
import { translate } from "@/lib/translate";
import { lemma } from "@/lib/lemma";
import { isKnown, occurrencesInBook } from "@/lib/words";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TARGETS = new Set(["kk", "ru", "en", "tr", "de", "fr", "es", "zh-CN", "ar"]);

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    target?: string;
    bookId?: number;
  };
  const text = (body.text ?? "").trim();
  const target = body.target && ALLOWED_TARGETS.has(body.target) ? body.target : "kk";

  if (!text) return NextResponse.json({ error: "Nothing to translate." }, { status: 400 });
  if (text.length > 1200) {
    return NextResponse.json({ error: "Select a shorter passage (1200 characters max)." }, { status: 400 });
  }

  try {
    const result = await translate(text, target);

    // For a single word, say how much of the book hangs on knowing it.
    if (result.kind === "word") {
      const base = lemma(text);
      const bookId = Number(body.bookId);
      const [known, occurrences] = await Promise.all([
        isKnown(userId, [base]),
        Number.isInteger(bookId)
          ? occurrencesInBook(userId, bookId, text)
          : Promise.resolve(0),
      ]);
      return NextResponse.json({
        ...result,
        lemma: base,
        known: known.has(base),
        occurrences,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Translation failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
