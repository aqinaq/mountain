import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import ServiceWorker from "@/components/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mountain — read English, understand every word",
  description:
    "Read English e-books with instant Kazakh translation and word-by-word explanations.",
  appleWebApp: {
    capable: true,
    title: "Mountain",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  // Two values so the browser chrome matches whichever palette is showing.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f7f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1511" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // The reader is a full-height app; let it use the notch area on a phone.
  viewportFit: "cover",
};

/**
 * Applies a pinned theme while the HTML is still being parsed, before anything
 * is painted. Without it a reader who chose light gets a flash of dark on every
 * load — the stored preference is not knowable until the client runs.
 * No stored value means "system", which needs no attribute at all.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("mountain.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Nav />
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
