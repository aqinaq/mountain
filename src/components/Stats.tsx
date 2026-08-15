"use client";

import { useCallback, useEffect, useState } from "react";
import type { Stats as StatsData } from "@/lib/stats";
import { duration } from "@/lib/format";

type KnownInfo = { count: number; core: { total: number; presets: number[] } };

export default function Stats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [known, setKnown] = useState<KnownInfo | null>(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    const [s, k] = await Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/known").then((r) => r.json()),
    ]);
    setStats(s as StatsData);
    setKnown(k as KnownInfo);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const seed = useCallback(
    async (count: number) => {
      setSeeding(true);
      try {
        await fetch("/api/known", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seed: count }),
        });
        await load();
      } finally {
        setSeeding(false);
      }
    },
    [load],
  );

  const clear = useCallback(async () => {
    if (!confirm("Forget every word marked as known? Your saved vocabulary is not affected.")) {
      return;
    }
    setSeeding(true);
    try {
      await fetch("/api/known?clear=all", { method: "DELETE" });
      await load();
    } finally {
      setSeeding(false);
    }
  }, [load]);

  if (!stats || !known) {
    return <p className="py-24 text-center text-sm text-[var(--text-dim)]">Loading…</p>;
  }

  const accuracy = stats.reviewedTotal
    ? Math.round((stats.correctTotal / stats.reviewedTotal) * 100)
    : null;

  return (
    <main className="page">
      <h1 className="display text-[2rem] leading-[1.1] sm:text-[2.5rem]">Progress</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-dim)]">
        Time with a book actually open, and what came out of it.
      </p>

      <div className="sheet mt-10 grid grid-cols-2 gap-x-5 gap-y-7 sm:gap-x-8 lg:grid-cols-4">
        <Tile
          value={`${stats.streak}`}
          unit={stats.streak === 1 ? "day" : "days"}
          label="Current streak"
          hint={stats.longestStreak > stats.streak ? `best ${stats.longestStreak}` : undefined}
        />
        <Tile value={duration(stats.todaySeconds)} label="Read today" />
        <Tile value={duration(stats.totalSeconds)} label="Read in total" hint={`${stats.daysRead} days`} />
        <Tile
          value={stats.wordsRead.toLocaleString()}
          unit="words"
          label="Words read"
          hint="estimated from progress"
        />
      </div>

      <Heatmap days={stats.days} />

      <div className="sheet mt-10 grid grid-cols-2 gap-x-5 gap-y-7 sm:gap-x-8 lg:grid-cols-4">
        <Tile value={stats.vocabTotal.toLocaleString()} label="Words saved" />
        <Tile value={stats.dueTotal.toLocaleString()} label="Cards due now" />
        <Tile value={stats.reviewedTotal.toLocaleString()} label="Reviews done" />
        <Tile
          value={accuracy === null ? "—" : `${accuracy}%`}
          label="Answered correctly"
          hint={accuracy === null ? "no reviews yet" : undefined}
        />
      </div>

      {/* ---------------- known words ---------------- */}
      <section className="sheet mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="display text-2xl">Words you already know</h2>
          <span className="text-sm text-[var(--accent)]">
            {stats.knownTotal.toLocaleString()} marked
          </span>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--text-dim)]">
          Known words are faded in the reader and kept out of your study list, so what stands out on
          the page is what you have yet to learn. Mark them as you read with{" "}
          <span className="text-[var(--text)]">I know it</span>, or start from the common-word list
          below — nothing here is permanent.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-[var(--text-dim)]">Add the most common</span>
          {known.core.presets.map((n) => (
            <button
              key={n}
              className="chip"
              disabled={seeding}
              onClick={() => void seed(n)}
              title={`Mark the ${n} commonest English words as known`}
            >
              {n >= known.core.total ? `all ${known.core.total}` : n}
            </button>
          ))}

          {stats.knownTotal > 0 && (
            <button
              className="chip ml-auto text-[var(--danger)] hover:text-[var(--danger)]"
              disabled={seeding}
              onClick={() => void clear()}
              title="Forget every word marked as known"
            >
              Clear the list
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

function Tile({
  value,
  unit,
  label,
  hint,
}: {
  value: string;
  unit?: string;
  label: string;
  hint?: string;
}) {
  // No box: the number is the tile. A label above it in small caps and a rule
  // to its left are enough to keep four of them from running together.
  // Two of these to a phone screen is a narrow column, and not every value is a
  // number — "under a minute" has to be allowed to take a second line.
  return (
    <div className="border-l border-[var(--border)] pl-3 sm:pl-4">
      <p className="eyebrow">{label}</p>
      <p className="display mt-1.5 text-[1.75rem] leading-tight sm:text-[2rem] sm:leading-none">
        {value}
        {unit && (
          <span className="ml-1.5 font-sans text-xs text-[var(--text-dim)]">{unit}</span>
        )}
      </p>
      {hint && <p className="mt-1.5 text-[11px] text-[var(--text-dim)]">{hint}</p>}
    </div>
  );
}

/**
 * Twelve weeks of activity. Intensity comes from minutes read, but a day with
 * only reviews still lights up — the point is whether you showed up.
 */
function Heatmap({ days }: { days: { day: string; seconds: number; reviewed: number }[] }) {
  const level = (d: { seconds: number; reviewed: number }) => {
    const mins = d.seconds / 60;
    if (mins >= 45) return 4;
    if (mins >= 20) return 3;
    if (mins >= 5) return 2;
    if (mins > 0 || d.reviewed > 0) return 1;
    return 0;
  };

  // Columns are weeks, rows are weekdays, so it reads like a calendar.
  const weeks: (typeof days)[] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return (
    <section className="sheet mt-10">
      <h2 className="display text-2xl">The last twelve weeks</h2>
      <div className="scroll-thin mt-5 overflow-x-auto pb-1">
        <div className="flex gap-1">
          {weeks.map((week, i) => (
            <div key={i} className="flex flex-col gap-1">
              {week.map((d) => (
                <span
                  key={d.day}
                  className="heat-cell"
                  data-level={level(d)}
                  title={`${d.day} · ${duration(d.seconds)}${
                    d.reviewed ? ` · ${d.reviewed} reviews` : ""
                  }`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="heat-cell" data-level={l} />
        ))}
        <span>More</span>
      </div>
    </section>
  );
}
