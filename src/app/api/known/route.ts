import { NextResponse } from "next/server";
import { CORE_PRESETS, CORE_WORDS } from "@/lib/core-words";
import {
  allKnownLemmas,
  clearKnown,
  knownCount,
  markKnown,
  seedCoreWords,
  unmarkKnown,
} from "@/lib/words";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The words you have told us you already know. The reader fetches the whole list
 * once per chapter — it is a few thousand short strings at most, and having it
 * client-side is what lets known words be dimmed without a round trip per word.
 */
export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const full = new URL(req.url).searchParams.get("list") === "1";
  return NextResponse.json({
    count: knownCount(userId),
    lemmas: full ? allKnownLemmas(userId) : undefined,
    core: { total: CORE_WORDS.length, presets: CORE_PRESETS },
  });
}

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const body = (await req.json().catch(() => ({}))) as {
    lemmas?: string[];
    /** Accept the first N words of the built-in common-word list. */
    seed?: number;
  };

  let added = 0;
  if (Number.isFinite(body.seed)) added += seedCoreWords(userId, Number(body.seed));
  if (Array.isArray(body.lemmas) && body.lemmas.length) {
    added += markKnown(userId, body.lemmas.slice(0, 5000).map(String));
  }

  return NextResponse.json({ ok: true, added, count: knownCount(userId) });
}

/** `?lemma=x` forgets one word; `?clear=all|seed|manual` forgets a whole group. */
export async function DELETE(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const params = new URL(req.url).searchParams;

  const clear = params.get("clear");
  if (clear) {
    if (!["all", "seed", "manual"].includes(clear)) {
      return NextResponse.json({ error: "Unknown group to clear." }, { status: 400 });
    }
    const removed = clearKnown(userId, clear === "all" ? undefined : (clear as "seed" | "manual"));
    return NextResponse.json({ ok: true, removed, count: knownCount(userId) });
  }

  const lemma = params.get("lemma");
  if (!lemma) return NextResponse.json({ error: "A lemma is required." }, { status: 400 });
  unmarkKnown(userId, lemma);
  return NextResponse.json({ ok: true, count: knownCount(userId) });
}
