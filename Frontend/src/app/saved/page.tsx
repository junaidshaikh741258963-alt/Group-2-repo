import type { Metadata } from "next";
import SavedPlacesView from "@/components/saved/SavedPlacesView";

export const metadata: Metadata = {
  title: "Saved places · TripCraft",
  description: "Every place you saved from Explore, chat and the map, in one list.",
};

export default function SavedPage() {
  return <SavedPlacesView />;
}
