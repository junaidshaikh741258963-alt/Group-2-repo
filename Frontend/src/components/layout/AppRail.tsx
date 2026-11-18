"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Brand from "@/components/layout/Brand";
import { APP_NAV, isAppNavActive } from "@/components/layout/appNav";
import { useExitTransition } from "@/lib/useExitTransition";

/**
 * The app rail used by every non-chat page. Same 188px column, same brand,
 * same destinations and footer as the chat rail — the page header changes with
 * the route, the shell does not. Mobile keeps the drawer: backdrop, slide-in,
 * close on navigate.
 */
export default function AppRail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [backdropMounted, backdropClosing] = useExitTransition(open, 240);

  return (
    <>
      {backdropMounted && (
        <div
          className={`fixed inset-0 z-50 bg-black/60 lg:hidden ${
            backdropClosing ? "animate-exit pointer-events-none" : "animate-fade-in"
          }`}
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed lg:sticky top-0 z-50 lg:z-auto h-dvh w-47 shrink-0 overflow-hidden border-r border-hairline bg-[#0b0b0c] flex flex-col transition-[transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0`}
      >
        <div className="flex h-full w-47 flex-col">
          <div className="flex h-12 shrink-0 items-center px-4">
            <Brand size="sm" onClick={onClose} />
            <button
              onClick={onClose}
              className="ml-auto grid h-8 w-8 place-items-center rounded-md text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
              aria-label="Close navigation"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18 18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <nav aria-label="App" className="shrink-0 px-2 pt-2">
            {APP_NAV.map((item) => {
              const active = isAppNavActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
                    active
                      ? "bg-white/[0.07] text-ink"
                      : "text-zinc-300 hover:bg-white/[0.05] hover:text-ink"
                  }`}
                >
                  <svg
                    className="h-4 w-4 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                  </svg>
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto shrink-0 border-t border-white/[0.07] px-3 py-3">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-orange-400 text-white">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <circle cx="12" cy="8" r="3.2" />
                  <path strokeLinecap="round" d="M5.5 20a6.5 6.5 0 0 1 13 0" />
                </svg>
              </span>
              <span className="min-w-0 flex-1 truncate text-2xs font-semibold text-zinc-200">
                Your account
              </span>
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
                aria-label="Account menu"
              >
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <circle cx="5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
