import type { MetadataRoute } from "next";

/**
 * Web app manifest — makes TripCraft installable and gives the offline
 * service worker a themed shell. Icons live in /public/icons (192, 512,
 * a maskable 512 and the 180px apple-touch icon).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TripCraft — AI trip planner",
    short_name: "TripCraft",
    description:
      "Plan a trip in chat: day-by-day itineraries, hotels, restaurants, flights and a live map.",
    start_url: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["travel", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Plan in chat", url: "/chat" },
      { name: "Saved trips", url: "/trips" },
    ],
  };
}
