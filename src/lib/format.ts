export function formatWords(n: number): string {
  if (!n) return "";
  if (n >= 1000) return `${Math.round(n / 1000)}k words`;
  return `${n} words`;
}

export function readingTime(words: number): string {
  const minutes = Math.round(words / 200);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Seconds as a compact duration: "42 min", "3h 05m", "—" for nothing. */
export function duration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return seconds > 0 ? "under a minute" : "—";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}

export function relativeTime(ts: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "kk", label: "Қазақша" },
  { code: "ru", label: "Русский" },
  { code: "tr", label: "Türkçe" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "zh-CN", label: "中文" },
  { code: "ar", label: "العربية" },
];
