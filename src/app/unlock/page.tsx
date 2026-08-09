import { redirect } from "next/navigation";
import { gatePassword, safeNext } from "@/lib/gate";

export const dynamic = "force-dynamic";

/**
 * The one page a locked-out browser is allowed to see. It names the app and
 * nothing else — no titles, no counts, nothing about whose library this is.
 */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; bad?: string }>;
}) {
  // Nothing to unlock when no password is configured, and a form that cannot
  // let anyone in is only a dead end to stumble into.
  if (!gatePassword()) redirect("/");

  const { next, bad } = await searchParams;
  const target = safeNext(next ?? "/");

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-5">
      <h1 className="display flex items-baseline gap-2 text-[19px]">
        <span aria-hidden className="text-base leading-none text-[var(--accent)]">
          ⛰
        </span>
        mountain
      </h1>

      <form action="/api/unlock" method="post" className="mt-6 flex flex-col gap-3">
        <input type="hidden" name="next" value={target} />

        <label htmlFor="password" className="text-[13px] text-[var(--text-dim)]">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          className="rounded-md border border-[var(--border-strong)] bg-[var(--field-bg)] px-3 py-2 text-[15px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />

        {bad ? (
          <p role="alert" className="text-[13px] text-[var(--danger)]">
            That is not the password.
          </p>
        ) : null}

        <button
          type="submit"
          className="mt-1 rounded-md bg-[var(--accent)] px-3 py-2 text-[14px] text-[var(--bg)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Unlock
        </button>
      </form>
    </main>
  );
}
