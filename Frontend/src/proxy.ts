import { NextResponse, type NextRequest } from "next/server";

/**
 * Request proxy (Next 16's `proxy.ts`, formerly middleware).
 *
 * Two jobs, both thin so they can run on every request:
 *  1. Security headers for pages and APIs (nosniff, frame deny, referrer
 *     policy, geolocation limited to self — the map needs it).
 *  2. Lock down the API to same-origin browser calls. All /api routes are
 *     app-internal: an Origin from another site is a 403, and preflights are
 *     answered explicitly instead of being guessed by route handlers.
 */

const API_PREFIX = "/api/";

// Paths that must stay callable without browser-origin checks (crawlers,
// health checks, future webhooks) would be listed here.
const ORIGIN_EXEMPT: string[] = [];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith(API_PREFIX);

  if (isApi && !ORIGIN_EXEMPT.some((p) => pathname.startsWith(p))) {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (request.method === "OPTIONS") {
      const sameOrigin = !origin || !host || safeHost(origin) === host;
      return new NextResponse(null, {
        status: sameOrigin ? 204 : 403,
        headers: sameOrigin
          ? {
              Allow: "GET, POST, OPTIONS",
              "Access-Control-Allow-Origin": origin ?? "",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
              Vary: "Origin",
            }
          : { Vary: "Origin" },
      });
    }
    if (origin && host && safeHost(origin) !== host) {
      return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
    }
  }

  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  // API responses are turn-by-turn data: never cache — except the image
  // proxy, whose whole point is long-lived immutable caching.
  if (isApi && !pathname.startsWith("/api/img")) response.headers.set("Cache-Control", "no-store");
  return response;
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icons/|sw\\.js|manifest\\.webmanifest).*)"],
};
