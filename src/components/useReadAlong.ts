"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { blocksOf, wordOffsets } from "@/lib/text-dom";

/**
 * Reads the chapter aloud with the current word highlighted.
 *
 * One utterance per paragraph rather than one for the whole chapter: long
 * utterances get truncated or dropped by several browsers, and a per-paragraph
 * queue also gives a natural place to scroll the next block into view.
 *
 * Word highlighting rides on `onboundary`, which not every engine fires. When it
 * is missing the paragraph is still highlighted as a whole, so the feature
 * degrades instead of looking broken.
 */

export type ReadAlong = {
  supported: boolean;
  playing: boolean;
  rate: number;
  setRate: (rate: number) => void;
  /** Start from the block nearest the top of the viewport, or resume. */
  toggle: () => void;
  stop: () => void;
};

const RATE_KEY = "mountain.speechRate.v1";

export function useReadAlong(
  contentRef: React.RefObject<HTMLDivElement | null>,
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  /** Changing this stops playback — a new chapter should not keep reading the old one. */
  resetKey: unknown,
): ReadAlong {
  const [supported, setSupported] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);

  const blockIndex = useRef(0);
  const highlighted = useRef<HTMLElement | null>(null);
  const activeBlock = useRef<HTMLElement | null>(null);
  const cancelled = useRef(false);
  const rateRef = useRef(1);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(true);
    const saved = Number(localStorage.getItem(RATE_KEY));
    if (saved >= 0.5 && saved <= 2) {
      rateRef.current = saved;
      setRateState(saved);
    }
  }, []);

  const clearHighlight = useCallback(() => {
    if (highlighted.current) delete highlighted.current.dataset.speaking;
    highlighted.current = null;
    if (activeBlock.current) delete activeBlock.current.dataset.speakingBlock;
    activeBlock.current = null;
  }, []);

  const stop = useCallback(() => {
    cancelled.current = true;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    clearHighlight();
    setPlaying(false);
  }, [clearHighlight]);

  // A chapter change, or leaving the page, must not leave speech running. This
  // belongs in the cleanup rather than the effect body: it is teardown of the
  // previous chapter's playback, and it covers unmount for free.
  useEffect(() => {
    return () => {
      stop();
      blockIndex.current = 0;
    };
  }, [resetKey, stop]);

  const speakFrom = useCallback(
    (start: number) => {
      const root = contentRef.current;
      if (!root) return;

      const blocks = blocksOf(root);
      cancelled.current = false;

      const speakBlock = (i: number) => {
        if (cancelled.current || i >= blocks.length) {
          clearHighlight();
          setPlaying(false);
          return;
        }

        blockIndex.current = i;
        const block = blocks[i];
        const text = (block.textContent ?? "").trim();
        if (!text) {
          speakBlock(i + 1);
          return;
        }

        clearHighlight();
        activeBlock.current = block;
        block.dataset.speakingBlock = "1";

        const scroller = scrollerRef.current;
        if (scroller) {
          const top =
            block.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop;
          // Only chase the text when it has drifted off screen.
          const offscreen =
            top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 80;
          if (offscreen) scroller.scrollTo({ top: Math.max(0, top - 120), behavior: "smooth" });
        }

        const offsets = wordOffsets(block);
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-US";
        utterance.rate = rateRef.current;

        utterance.onboundary = (e) => {
          if (cancelled.current || e.name === "sentence") return;
          const at = e.charIndex;
          let match: HTMLElement | null = null;
          for (const o of offsets) {
            if (o.start <= at && at < o.end) {
              match = o.el;
              break;
            }
            if (o.start > at) break;
          }
          if (!match || match === highlighted.current) return;
          if (highlighted.current) delete highlighted.current.dataset.speaking;
          match.dataset.speaking = "1";
          highlighted.current = match;
        };

        utterance.onend = () => {
          if (highlighted.current) delete highlighted.current.dataset.speaking;
          highlighted.current = null;
          if (!cancelled.current) speakBlock(i + 1);
        };

        utterance.onerror = () => {
          if (!cancelled.current) speakBlock(i + 1);
        };

        window.speechSynthesis.speak(utterance);
      };

      window.speechSynthesis.cancel();
      speakBlock(start);
      setPlaying(true);
    },
    [clearHighlight, contentRef, scrollerRef],
  );

  const toggle = useCallback(() => {
    if (playing) {
      stop();
      return;
    }

    // Begin at whatever the reader is actually looking at.
    const root = contentRef.current;
    const scroller = scrollerRef.current;
    let start = blockIndex.current;
    if (root && scroller) {
      const blocks = blocksOf(root);
      const top = scroller.getBoundingClientRect().top;
      const found = blocks.findIndex((b) => b.getBoundingClientRect().bottom > top + 8);
      start = found >= 0 ? found : 0;
    }
    speakFrom(start);
  }, [contentRef, playing, scrollerRef, speakFrom, stop]);

  const setRate = useCallback(
    (next: number) => {
      const clamped = Math.min(2, Math.max(0.5, next));
      rateRef.current = clamped;
      setRateState(clamped);
      try {
        localStorage.setItem(RATE_KEY, String(clamped));
      } catch {
        /* private mode, ignore */
      }
      // The Web Speech API cannot retune an utterance in flight; restart the
      // paragraph so the new speed takes effect straight away.
      if (playing) speakFrom(blockIndex.current);
    },
    [playing, speakFrom],
  );

  return { supported, playing, rate, setRate, toggle, stop };
}
