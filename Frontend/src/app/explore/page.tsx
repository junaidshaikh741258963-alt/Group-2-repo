import { redirect } from "next/navigation";

/**
 * Explore has one window: the Explore tab of the planner. This route keeps
 * old links (footer, saved places, shared URLs) working by forwarding their
 * location params into that same window, so both doors open the same view.
 */
export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const next = new URLSearchParams({ view: "explore" });
  for (const key of ["name", "lat", "lng", "map"] as const) {
    const value = params[key];
    if (typeof value === "string" && value) next.set(key, value);
  }
  redirect(`/chat?${next.toString()}`);
}
