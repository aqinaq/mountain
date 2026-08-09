import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mountain — read English, understand every word",
    short_name: "Mountain",
    description:
      "Read English e-books with instant translation, word-by-word explanations and spaced repetition.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f3f7f3",
    theme_color: "#f3f7f3",
    categories: ["books", "education"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Review vocabulary", url: "/vocab" },
      { name: "Progress", url: "/stats" },
    ],
  };
}
