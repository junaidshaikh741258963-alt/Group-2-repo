"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import type { Conversation } from "@/lib/conversations";
import { useExitTransition } from "@/lib/useExitTransition";
import Brand from "@/components/layout/Brand";
import { APP_NAV, isAppNavActive } from "@/components/layout/appNav";

interface ChatSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Mobile overlay visibility. */
  open: boolean;
  /** Desktop collapse — the rail slides shut and the chat widens. */
  collapsed?: boolean;
  onClose: () => void;
}

function timeLabel(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The Mindtrip-style app rail: brand, the seven places you can be, the current
 * chat list, then New chat and the signed-in traveler. One column, quiet
 * icons, and the same 188px width on every screen — navigation should never
 * feel like a second product.
 */

export default function ChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  open,
  collapsed = false,
  onClose,
}: ChatSidebarProps) {
  const pathname = usePathname();
  const [backdropMounted, backdropClosing] = useExitTransition(open, 240);
  /** Recent first — the list is a history, not a queue. */
  const recents = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 14),
    [conversations]
  );

  return (
    <>
      {backdropMounted && (
        <div
          className={`fixed inset-0 z-30 bg-black/60 lg:hidden ${
            backdropClosing ? "animate-exit pointer-events-none" : "animate-fade-in"
          }`}
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed lg:sticky top-0 z-30 lg:z-auto h-dvh w-47 shrink-0 overflow-hidden border-r border-hairline bg-[#0b0b0c] flex flex-col transition-[transform,width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 ${collapsed ? "lg:w-0 lg:border-transparent" : "lg:w-47"}`}
      >
        <div className="flex h-full w-47 flex-col">
          <div className="flex h-12 shrink-0 items-center px-4">
            <Brand size="sm" />
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
                  key={item.label}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors ${
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
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d={item.icon}
                    />
                  </svg>
                  <span className="truncate">{item.label}</span>
                  {item.label === "Chats" && conversations.length > 0 && (
                    <span className="ml-auto rounded-full bg-white/[0.08] px-2 py-0.5 text-2xs tabular-nums text-zinc-400">
                      {conversations.length}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="mt-4 flex min-h-0 flex-1 flex-col px-2">
            <div className="flex items-center gap-2 px-3 pb-2">
              <span className="text-2xs font-medium uppercase tracking-[0.12em] text-zinc-500">
                Recent
              </span>
              <span className="h-px flex-1 bg-white/[0.06]" aria-hidden />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto dark-scroll pb-2">
              <nav aria-label="Conversations" className="space-y-0.5">
                {recents.map((c) => {
                  const active = c.id === activeId;
                  return (
                    <div
                      key={c.id}
                      className={`group flex items-center rounded-lg transition-colors ${
                        active ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
                      }`}
                    >
                      <button
                        onClick={() => onSelect(c.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left"
                        title={c.title}
                      >
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-xs ${
                              active ? "font-medium text-ink" : "text-zinc-400"
                            }`}
                          >
                            {c.title}
                          </span>
                          <span className="mt-0.5 block text-3xs text-zinc-600">
                            {timeLabel(c.updatedAt)}
                          </span>
                        </span>
                      </button>
                      <button
                        onClick={() => onDelete(c.id)}
                        className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-600 opacity-0 transition-colors hover:bg-red-500/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete conversation ${c.title}`}
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7 18.1 19.1A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.9L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </nav>
              {recents.length === 0 && (
                <p className="px-3 py-2 text-xs leading-relaxed text-zinc-600">
                  Your chats live here.
                </p>
              )}
            </div>

            <button
              onClick={onNew}
              className="mx-1 mb-2 flex h-8 w-[calc(100%-8px)] items-center justify-center rounded-full bg-white/[0.06] text-xs font-medium text-zinc-200 transition-colors hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            >
              New chat
            </button>
          </div>

          <div className="shrink-0 border-t border-white/[0.07] px-3 py-3">
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
