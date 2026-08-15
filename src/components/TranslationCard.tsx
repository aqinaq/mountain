"use client";

import { useEffect, useState } from "react";
import type { TranslateResult } from "@/lib/translate";

export type Anchor = { x: number; y: number; top: number; bottom: number };

type Props = {
  term: string;
  context: string;
  result: TranslateResult | null;
  loading: boolean;
  error: string;
  saved: boolean;
  known: boolean;
  anchor: Anchor | null;
  onClose: () => void;
  onSave: () => void;
  onMarkKnown: () => void;
  onTranslateContext: () => void;
};

const POP_W = 350;

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
}

export default function TranslationCard({
  term,
  context,
  result,
  loading,
  error,
  saved,
  known,
  anchor,
  onClose,
  onSave,
  onMarkKnown,
  onTranslateContext,
}: Props) {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!anchor) return null;

  // On a phone the card is a sheet across the foot of the screen, not a popup
  // pinned to the word: a 350px card beside a word on a 390px screen has
  // nowhere to go, and the sheet leaves the sentence you tapped in view.
  // Below the word if it fits, otherwise above it.
  const style: React.CSSProperties = narrow
    ? { left: 0, right: 0, bottom: 0, maxHeight: "62dvh", borderRadius: "16px 16px 0 0" }
    : (() => {
        const spaceBelow = window.innerHeight - anchor.bottom;
        const above = spaceBelow < 260 && anchor.top > 260;
        return {
          left: Math.min(Math.max(12, anchor.x - POP_W / 2), window.innerWidth - POP_W - 12),
          top: above ? undefined : anchor.bottom + 10,
          bottom: above ? window.innerHeight - anchor.top + 10 : undefined,
          width: POP_W,
          maxHeight: "min(58vh, 460px)",
        };
      })();

  const isPhrase = result?.kind === "phrase" || term.trim().includes(" ");

  return (
    <div
      className="pop-in scroll-thin fixed z-50 flex flex-col overflow-hidden overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text)] shadow-[var(--shadow-pop)]"
      style={style}
      // One event for both input kinds, and the one the reader listens for:
      // a tap anywhere outside this card closes it.
      onPointerDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={`Translation of ${term}`}
    >
      {/* The grab bar a sheet is expected to have. It does not drag — it says
          which edge the card is hinged on, and gives the thumb a margin at the
          top of the sheet that is not a button. */}
      {narrow && (
        <div className="flex justify-center pt-2 pb-1" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-[var(--border-strong)]" />
        </div>
      )}

      {/* Both buttons live at the top, above anything whose length varies. A
          translation, a stack of senses or a long sentence would otherwise
          push them to a different place on every word, and the button you
          meant to hit would not be where you last saw it. */}
      <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="break-words text-[15px] font-semibold">{term}</span>
              {result?.phonetic && (
                <span className="text-xs text-[var(--text-dim)]">{result.phonetic}</span>
              )}
            </div>
            {/* How much of the book turns on this one word. */}
            {(result?.occurrences ?? 0) > 1 && (
              <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">
                {result?.occurrences} times in this book
              </p>
            )}
          </div>
          <button
            onClick={() => speak(term)}
            className="shrink-0 rounded-md px-2 py-1.5 text-sm text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            title="Hear it in English"
            aria-label="Pronounce"
          >
            🔊
          </button>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1.5 text-sm text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 flex gap-2">
          <button className="btn btn-primary flex-1" onClick={onSave} disabled={saved || loading}>
            {saved ? "✓ Saved" : "Save to vocabulary"}
          </button>
          {/* The other answer to "what is this word": nothing, I know it
              already. Marking it takes the word out of the study list. */}
          {!isPhrase && (
            <button
              className="btn"
              onClick={onMarkKnown}
              disabled={known}
              title="Stop highlighting this word and count it as known"
            >
              {known ? "✓ Known" : "I know it"}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
        {loading && (
          <p className="flex items-center gap-2 py-3 text-sm text-[var(--text-dim)]">
            <span className="spin inline-block">◌</span> Translating…
          </p>
        )}

        {!loading && error && <p className="py-2 text-sm text-[var(--danger)]">{error}</p>}

        {!loading && result && (
          <>
            {result.translation ? (
              <p className="text-lg leading-snug font-medium text-[var(--accent)]">
                {result.translation}
              </p>
            ) : (
              <p className="text-sm text-[var(--danger)]">
                {result.error ?? "No translation came back."}
              </p>
            )}

            {result.senses.length > 0 && (
              <div className="mt-4 space-y-3 border-t border-[var(--border)] pt-3">
                {result.senses.map((s, i) => (
                  <div key={i}>
                    {s.partOfSpeech && (
                      <span className="mr-2 rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
                        {s.partOfSpeech}
                      </span>
                    )}
                    <span className="text-[13px] leading-relaxed">{s.definition}</span>
                    {s.definitionKk && (
                      <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-dim)]">
                        {s.definitionKk}
                      </p>
                    )}
                    {s.example && (
                      <p className="mt-1 border-l-2 border-[var(--border)] pl-2 text-[12px] italic text-[var(--text-dim)]">
                        {s.example}
                      </p>
                    )}
                    {s.synonyms.length > 0 && (
                      <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                        Similar: {s.synonyms.join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!isPhrase && context && context !== term && (
              <button
                onClick={onTranslateContext}
                className="mt-4 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-left text-[12px] leading-relaxed text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              >
                <span className="mb-1 block text-[10px] uppercase tracking-wide">
                  Translate the whole sentence →
                </span>
                {context.length > 130 ? `${context.slice(0, 130)}…` : context}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
