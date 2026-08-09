import { NextResponse } from "next/server";
import {
  answerCard,
  backfillCards,
  clozeFront,
  CARD_TYPES,
  dueBreakdown,
  dueCards,
  type CardType,
} from "@/lib/srs";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A card as the review screen needs it — prompt and answer already resolved. */
export type ReviewCard = {
  id: number;
  type: CardType;
  box: number;
  term: string;
  prompt: string;
  answer: string;
  context: string;
  bookTitle: string | null;
  /** Whether the prompt is English, which decides if the 🔊 button makes sense. */
  promptIsEnglish: boolean;
};

export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  await backfillCards(userId);

  const url = new URL(req.url);
  const requested = url.searchParams.get("type");
  const only = CARD_TYPES.includes(requested as CardType) ? (requested as CardType) : null;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));

  // Over-fetch a little: cards whose prompt cannot be built are dropped below.
  const cards: ReviewCard[] = [];
  for (const c of await dueCards(userId, limit + 20, only)) {
    let prompt = c.term;
    let answer = c.translation || "—";
    let promptIsEnglish = true;

    if (c.type === "produce") {
      // Nothing to ask for if we never got a translation back.
      if (!c.translation) continue;
      prompt = c.translation;
      answer = c.term;
      promptIsEnglish = false;
    } else if (c.type === "cloze") {
      const blanked = clozeFront(c.context, c.term, c.lemma);
      if (!blanked) continue;
      prompt = blanked;
      answer = c.term;
    }

    cards.push({
      id: c.id,
      type: c.type,
      box: c.box,
      term: c.term,
      prompt,
      answer,
      context: c.context,
      bookTitle: c.book_title,
      promptIsEnglish,
    });
    if (cards.length >= limit) break;
  }

  return NextResponse.json({ cards, due: await dueBreakdown(userId) });
}

export async function PATCH(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as { id?: number; correct?: boolean };
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "A card id is required." }, { status: 400 });
  }

  const result = await answerCard(userId, id, Boolean(body.correct));
  if (!result) return NextResponse.json({ error: "Card not found." }, { status: 404 });

  return NextResponse.json({ ok: true, ...result });
}
