import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/layout/AppShell";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TripCraft · Trip planning, itinerary and map",
  description:
    "Plan a trip in chat: day-by-day itineraries, hotels, restaurants, flights and a live map, built around your dates, budget and pace.",
  keywords: ["travel planner", "itinerary", "hotels", "flights", "restaurants", "trip planning"],
  openGraph: {
    title: "TripCraft · Trip planning, itinerary and map",
    description:
      "Plan a trip in chat: day-by-day itineraries, hotels, restaurants, flights and a live map.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  // Let the on-screen keyboard resize the layout viewport (Android Chrome)
  // instead of overlaying the page and panning it up when the composer is
  // focused — the pan is the "typing moves the whole window" jump.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full`} data-scroll-behavior="smooth">
      <body className="min-h-full flex flex-col bg-zinc-950 font-sans text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
