"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { VocabRow } from "@/app/api/vocab/route";
import type { ReviewCard } from "@/app/api/cards/route";
import type { DueBreakdown } from "@/lib/srs";
import { relativeTime } from "@/lib/format";

type Mode = "list" | "review";

const EMPTY_DUE: DueBreakdown = { total: 0, recognize: 0, produce: 0, cloze: 0 };

const CARD_LABEL: Record<string, string> = {
  recognize: "Recognise",
  produce: "Produce",
  cloze: "In context",
};

const CARD_HINT: Record<string, string> = {
  recognize: "What does this English word mean?",
  produce: "What is the English for this?",
  cloze: "Which word fills the gap?",
};

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
}

export default function Vocabulary() {
  const [items, setItems] = useState<VocabRow[] | null>(null);
  const [due, setDue] = useState<DueBreakdown>(EMPTY_DUE);
  const [mode, setMode] = useState<Mode>("list");
  const [reviewType, setReviewType] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/vocab");
    const data = await res.json();
    setItems(data.items ?? []);
    setDue((data.due ?? EMPTY_DUE) as DueBreakdown);
  }, []);

  // Load-on-mount: every setState happens after the await, not during render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const remove = useCallback(async (id: number) => {
    await fetch(`/api/vocab?id=${id}`, { method: "DELETE" });
    setItems((prev) => prev?.filter((v) => v.id !== id) ?? null);
  }, []);

  if (mode === "review") {
    return (
      <Review
        type={reviewType}
        onExit={() => void load().then(() => setMode("list"))}
      />
    );
  }

  const startReview = (type: string | null) => {
    setReviewType(type);
    setMode("review");
  };

  const visible = (items ?? []).filter((v) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      v.term.toLowerCase().includes(q) ||
      v.translation.toLowerCase().includes(q) ||
      (v.book_title ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <main className="page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-[2rem] leading-[1.1] sm:text-[2.5rem]">Vocabulary</h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-dim)]">
            Every word you saved while reading.{" "}
            {due.total > 0 && `${due.total} card${due.total === 1 ? "" : "s"} ready to review.`}
          </p>
        </div>
        <div className="flex gap-3">
          <a className="btn" href="/api/vocab/export" download title="Tab-separated, ready to import into Anki">
            Export
          </a>
          <button className="btn btn-primary" onClick={() => startReview(null)} disabled={due.total === 0}>
            Review {due.total > 0 ? `(${due.total})` : ""}
          </button>
        </div>
      </div>

      {/* Each direction is its own pile of cards, and each is worth a separate
          session — recognising a word is a different skill from producing it. */}
      {due.total > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {(["recognize", "produce", "cloze"] as const).map((type) =>
            due[type] > 0 ? (
              <button
                key={type}
                onClick={() => startReview(type)}
                className="chip"
                title={CARD_HINT[type]}
              >
                {CARD_LABEL[type]} · {due[type]}
              </button>
            ) : null,
          )}
        </div>
      )}

      {items === null ? (
        <p className="py-16 text-sm text-[var(--text-dim)]">Loading…</p>
      ) : items.length === 0 ? (
        <div className="sheet mt-10">
          <p className="text-sm text-[var(--text-dim)]">
            Nothing saved yet. Tap a word while{" "}
            <Link href="/" className="text-[var(--accent)] underline underline-offset-4">
              reading
            </Link>{" "}
            and press “Save to vocabulary”.
          </p>
        </div>
      ) : (
        <>
          <input
            className="field mt-10"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <ul className="mt-2">
            {visible.map((v) => (
              <li key={v.id} className="row flex items-start gap-4 px-2 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="display text-[17px]">{v.term}</span>
                    <span className="text-sm text-[var(--accent)]">{v.translation}</span>
                    <span className="eyebrow text-[10px]">
                      box {v.min_box}/5 · {v.card_count} card{v.card_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  {v.context && (
                    <p className="mt-1.5 line-clamp-2 border-l border-[var(--border)] pl-2.5 text-xs italic text-[var(--text-dim)]">
                      {v.context}
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] text-[var(--text-dim)]">
                    {[v.book_title, relativeTime(v.created_at)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <button
                  onClick={() => void remove(v.id)}
                  className="hover-reveal shrink-0 px-1 py-1 text-[11px] text-[var(--text-dim)] underline underline-offset-4 hover:text-[var(--danger)]"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

/* ------------------------- flashcards ------------------------- */

function Review({ type, onExit }: { type: string | null; onExit: () => void }) {
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState({ right: 0, wrong: 0 });

  useEffect(() => {
    fetch(`/api/cards${type ? `?type=${type}` : ""}`)
      .then((r) => r.json())
      .then((d) => setQueue((d.cards ?? []) as ReviewCard[]));
  }, [type]);

  const card = queue?.[pos];

  const answer = useCallback(
    async (correct: boolean) => {
      if (!card) return;
      setScore((s) => ({ right: s.right + (correct ? 1 : 0), wrong: s.wrong + (correct ? 0 : 1) }));
      setRevealed(false);
      setPos((p) => p + 1);
      await fetch("/api/cards", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id, correct }),
      });
    },
    [card],
  );

  // Keyboard: space reveals, then 1 and 2 answer. Reviewing is repetitive
  // enough that reaching for the mouse every card is its own friction.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else void answer(true);
      }
      if (revealed && e.key === "1") void answer(false);
      if (revealed && e.key === "2") void answer(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer, card, revealed]);

  if (queue === null) {
    return <p className="py-24 text-center text-sm text-[var(--text-dim)]">Loading…</p>;
  }

  if (!card) {
    return (
      <main className="mx-auto max-w-xl px-4 pt-20 pb-[calc(5rem_+_env(safe-area-inset-bottom))] text-center">
        <p className="text-3xl text-[var(--accent)]" aria-hidden>
          ✓
        </p>
        <h1 className="display mt-4 text-2xl">
          {queue.length === 0 ? "Nothing due" : "Session finished"}
        </h1>
        <p className="mt-2 text-sm text-[var(--text-dim)]">
          {queue.length === 0
            ? "These cards come back when they are due."
            : `${score.right} correct · ${score.wrong} to revisit`}
        </p>
        <button className="btn btn-primary mt-6" onClick={onExit}>
          Back to vocabulary
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 pt-8 pb-[calc(2.5rem_+_env(safe-area-inset-bottom))] sm:pt-10">
      <div className="mb-6 flex items-center justify-between text-xs text-[var(--text-dim)]">
        <button onClick={onExit} className="-ml-1 px-1 py-1 hover:text-[var(--text)]">
          ← Exit
        </button>
        <span>
          {pos + 1} / {queue.length}
        </span>
      </div>

      {/* The card is a slip of paper on the desk: raised, warm, softly shadowed —
          the one place in the chrome that earns a shadow. */}
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-6 py-10 text-center shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2">
          <span className="eyebrow">{CARD_LABEL[card.type] ?? card.type}</span>
          <span className="text-[10px] text-[var(--text-dim)]">· box {card.box}/5</span>
        </div>

        <p className="text-[11px] text-[var(--text-dim)]">{CARD_HINT[card.type]}</p>

        <p
          className={
            card.type === "cloze"
              ? "display max-w-md text-xl leading-relaxed"
              : "display text-[2rem]"
          }
        >
          {card.prompt}
        </p>

        {card.promptIsEnglish && (
          <button
            onClick={() => speak(card.type === "cloze" ? card.context || card.term : card.prompt)}
            className="px-3 py-2 text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
            aria-label="Pronounce"
          >
            🔊
          </button>
        )}

        {revealed ? (
          <>
            <p className="display text-xl text-[var(--accent)]">{card.answer}</p>
            {/* A cloze already shows its sentence; repeating it below is noise. */}
            {card.type !== "cloze" && card.context && (
              <p className="max-w-md text-sm italic text-[var(--text-dim)]">“{card.context}”</p>
            )}
            {card.bookTitle && (
              <p className="text-[11px] text-[var(--text-dim)]">{card.bookTitle}</p>
            )}
          </>
        ) : (
          <button className="btn" onClick={() => setRevealed(true)}>
            Show answer <span className="text-[10px] text-[var(--text-dim)]">space</span>
          </button>
        )}
      </div>

      {revealed && (
        <div className="mt-4 flex gap-3">
          <button className="btn flex-1" onClick={() => void answer(false)}>
            Still learning <span className="text-[10px] text-[var(--text-dim)]">1</span>
          </button>
          <button className="btn btn-primary flex-1" onClick={() => void answer(true)}>
            I knew it <span className="text-[10px] opacity-70">2</span>
          </button>
        </div>
      )}
    </main>
  );
}
