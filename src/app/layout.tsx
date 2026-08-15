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
    // Not "black-translucent". That style paints the clock and the battery in
    // white over whatever the page puts under them, and the app now opens
    // light whatever the phone is set to — white on #f3f7f3 is nothing at all.
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  // One value, not a light/dark pair keyed off the machine: the app defaults to
  // light whatever the machine says, and a pair would tint the toolbar dark
  // around a light page. ThemeToggle rewrites this tag when the theme changes.
  themeColor: "#f3f7f3",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // The reader is a full-height app; let it use the notch area on a phone.
  viewportFit: "cover",
};

/**
 * Applies the theme while the HTML is still being parsed, before anything is
 * painted. Without it a reader on a dark machine gets a flash of dark on every
 * load — the stored preference is not knowable until the client runs.
 * Only an explicit "system" hands the decision to `prefers-color-scheme`;
 * anything else, including a first visit with nothing stored, is light.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("mountain.theme");if(t==="system")return;document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light")}catch(e){document.documentElement.setAttribute("data-theme","light")}})()`;

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
