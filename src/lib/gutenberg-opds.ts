import { XMLParser } from "fast-xml-parser";
import type { CatalogBook } from "./gutendex";

type OpdsLink = { rel?: string; href?: string };
type OpdsEntry = {
  id?: string;
  title?: string;
  content?: string | { "#text"?: string };
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
});

/** Parse Project Gutenberg's official OPDS feed into the catalog shape used by the UI. */
export function parseGutenbergOpds(xml: string): { books: CatalogBook[]; hasMore: boolean } {
  const feed = parser.parse(xml)?.feed as
    | { entry?: OpdsEntry | OpdsEntry[]; link?: OpdsLink | OpdsLink[] }
    | undefined;
  if (!feed) throw new Error("Project Gutenberg returned an unreadable catalog response.");

  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  const links = Array.isArray(feed.link) ? feed.link : feed.link ? [feed.link] : [];

  const books = entries.flatMap((entry): CatalogBook[] => {
    const id = Number(entry.id?.match(/\/ebooks\/(\d+)/)?.[1]);
    if (!Number.isInteger(id) || id <= 0) return [];

    const content = String(
      typeof entry.content === "string" ? entry.content : entry.content?.["#text"] ?? "",
    ).trim();
    const downloadMatch = content.match(/^([\d,]+) downloads$/i);

    return [
      {
        id,
        title: String(entry.title ?? `Gutenberg ${id}`).trim(),
        authors: downloadMatch ? "Unknown" : content || "Unknown",
        languages: ["en"],
        subjects: [],
        downloadCount: downloadMatch ? Number(downloadMatch[1].replaceAll(",", "")) : 0,
        coverUrl: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
        textUrl: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
      },
    ];
  });

  return { books, hasMore: links.some((link) => link.rel === "next") };
}
