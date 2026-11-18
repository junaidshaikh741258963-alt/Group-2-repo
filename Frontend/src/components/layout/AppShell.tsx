"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import AppRail from "@/components/layout/AppRail";
import Navbar from "@/components/layout/Navbar";
import { TripItemsProvider } from "@/components/trip/TripItemsContext";
import { LiveItineraryProvider } from "@/components/trip/LiveItineraryContext";
import ServiceWorkerRegistrar from "@/components/pwa/ServiceWorkerRegistrar";
import Toaster from "@/components/ui/Toaster";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  /* `/` is the chat now, so it gets the chat shell (no global rail) just like
     `/chat`. Every other route shares the app rail + 48px page header. */
  const isChat = pathname === "/" || Boolean(pathname?.startsWith("/chat"));
  const withNav = !isChat;
  const [railOpen, setRailOpen] = useState(false);

  return (
    <LiveItineraryProvider>
      <TripItemsProvider>
        {withNav ? (
          <div className="flex min-h-dvh w-full">
            <AppRail open={railOpen} onClose={() => setRailOpen(false)} />
            <div className="flex min-w-0 flex-1 flex-col">
              <Navbar onOpenRail={() => setRailOpen(true)} />
              <main className="flex-1">
                <div key={pathname} className="page-in">
                  {children}
                </div>
              </main>
            </div>
          </div>
        ) : (
          <div key={pathname} className="page-in">
            {children}
          </div>
        )}
        <Toaster />
        <ServiceWorkerRegistrar />
      </TripItemsProvider>
    </LiveItineraryProvider>
  );
}
