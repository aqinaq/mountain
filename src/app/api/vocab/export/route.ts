import { getDb } from "@/lib/db";
import { dayKey } from "@/lib/db";
import { currentUserId, noSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  term: string;
  translation: string;
  context: string;
  lemma: string;
  book_title: string | null;
  created_at: number;
};

/** Anki reads tab-separated fields; a literal tab or newline inside one breaks it. */
function cell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function csvCell(value: string): string {
  const v = value.replace(/\r?\n/g, " ").trim();
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Vocabulary as a file Anki can import directly. TSV is Anki's native paste
 * format — fields map to Front / Back / Context / Source / Tags in order — and
 * CSV is there for spreadsheets.
 */
export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return noSession();

  const format = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "tsv";

  const db = await getDb();
  const rows = await db.all<Row>(
    `SELECT v.term, v.translation, v.context, v.lemma, b.title AS book_title, v.created_at
       FROM vocab v
       LEFT JOIN books b ON b.id = v.book_id
      WHERE v.user_id = ?
      ORDER BY v.created_at`,
    userId,
  );

  const lines: string[] = [];

  if (format === "csv") {
    lines.push(["Front", "Back", "Context", "Source", "Tags"].join(","));
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.term),
          csvCell(r.translation),
          csvCell(r.context),
          csvCell(r.book_title ?? ""),
          csvCell(["mountain", r.lemma].filter(Boolean).join(" ")),
        ].join(","),
      );
    }
  } else {
    // Anki ignores lines starting with '#' as import directives/comments.
    lines.push("#separator:tab");
    lines.push("#html:false");
    lines.push("#tags column:5");
    for (const r of rows) {
      lines.push(
        [
          cell(r.term),
          cell(r.translation),
          cell(r.context),
          cell(r.book_title ?? ""),
          cell(["mountain", r.lemma].filter(Boolean).join(" ")),
        ].join("\t"),
      );
    }
  }

  const body = `${lines.join("\n")}\n`;
  const name = `mountain-vocabulary-${dayKey()}.${format}`;

  return new Response(body, {
    headers: {
      "Content-Type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
