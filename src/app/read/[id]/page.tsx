import { notFound } from "next/navigation";
import Reader from "@/components/Reader";
import { getBook, getChapters } from "@/lib/books";
import { currentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();

  // The proxy gives every request a session before it gets here, so a missing
  // one is not a case worth a page of its own.
  const userId = await currentUserId();
  if (!userId) notFound();

  const book = await getBook(userId, id);
  if (!book) notFound();

  return <Reader book={book} chapters={await getChapters(userId, id)} />;
}
