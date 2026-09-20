"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Reading the same library on a second device.
 *
 * There is no password to type on the new device and no address to send a link
 * to, so the account is handed over the way a streaming app hands over a TV:
 * this device shows a short code, the other one enters it, and from then on
 * both are signed in to the same library. The code is good for ten minutes and
 * for one use.
 */
export default function DeviceLink() {
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [left, setLeft] = useState(0);
  const [entered, setEntered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [outcome, setOutcome] = useState<"ok" | "failed" | "">("");

  // The claim itself happens in /claim, which redirects back here with the
  // answer in the query string — this is only where that answer is read out.
  useEffect(() => {
    const claim = new URLSearchParams(window.location.search).get("claim");
    if (claim === "ok" || claim === "failed") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOutcome(claim);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Counting down rather than printing a wall-clock time: "8:14 left" is
  // something you can act on, "expires at 19:42" is arithmetic.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, expiresAt - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const join = useCallback(async () => {
    const value = entered.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/link/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "That code did not work.");
      // The whole page is another account's now — the shelf, the vocabulary and
      // the progress figures all have to be fetched again.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work.");
      setBusy(false);
    }
  }, [entered]);

  const request = useCallback(async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const res = await fetch("/api/link", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create a code.");
      setCode(data.code);
      setExpiresAt(data.expiresAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a code.");
    } finally {
      setBusy(false);
    }
  }, []);

  const copyCode = useCallback(async () => {
    if (!code) return;
    setError("");
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setError("Could not copy the code. Select it and copy it manually.");
    }
  }, [code]);

  const expired = Boolean(code) && left <= 0;
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);

  return (
    <section className="mt-10 border-t border-[var(--border)] pt-6">
      <p className="eyebrow mb-3">Another device</p>

      {outcome === "ok" && (
        <p className="mb-4 border-l-2 border-[var(--good)] py-1 pl-3 text-sm text-[var(--text-dim)]">
          This device is now signed in to your library.
        </p>
      )}
      {outcome === "failed" && (
        <p className="mb-4 border-l-2 border-[var(--danger)] py-1 pl-3 text-sm text-[var(--danger)]">
          That code was wrong, already used, or too old. Ask the other device for a fresh one.
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        {/* This device hands out a code… */}
        <div>
          <p className="text-sm">Read this library on another device</p>
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            Show a code here, type it there. It lasts ten minutes and works once.
          </p>

          {code && !expired ? (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-mono text-lg tracking-[0.15em] select-all">{code}</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void copyCode()}
                  aria-live="polite"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-1 text-xs text-[var(--text-dim)]">
                {minutes}:{String(seconds).padStart(2, "0")} left · enter it under “Already have a
                code?” on the other device
              </p>
            </div>
          ) : (
            <button className="btn mt-3" onClick={() => void request()} disabled={busy}>
              {busy ? <span className="spin inline-block">◌</span> : expired ? "Show a new code" : "Show a code"}
            </button>
          )}
        </div>

        {/* …and this is where the other device puts it in. Both halves on one
            screen because either device might be either half. */}
        <form
          className="sm:border-l sm:border-[var(--border)] sm:pl-6"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <p className="text-sm">Already have a code?</p>
          <p className="mt-0.5 text-xs text-[var(--text-dim)]">
            Enter it to join the library it came from. Anything already saved on this device is
            added to it.
          </p>
          <div className="mt-3 flex items-end gap-3">
            <input
              className="field flex-1 font-mono tracking-[0.1em] uppercase"
              placeholder="XXXX-XXXX-XXXX"
              value={entered}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setEntered(e.target.value)}
            />
            <button className="btn" type="submit" disabled={busy || !entered.trim()}>
              Join
            </button>
          </div>
        </form>
      </div>

      {error && (
        <p className="mt-4 border-l-2 border-[var(--danger)] py-1 pl-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
