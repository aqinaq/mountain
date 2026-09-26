import Library from "@/components/Library";
import { listBooks } from "@/lib/books";
import { currentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const userId = await currentUserId();
  const books = userId ? await listBooks(userId) : [];

  return <Library initialBooks={books} />;
}
