"use client";

import { useEffect, useState } from "react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

// Registers the service worker in production builds and hands it the URLs this page loads, so the
// first visit is enough for the app to open with no signal. Scripts, the planner's WebAssembly and
// data can still be loading after the worker is ready but before it controls the page, so every
// later resource is handed over as it finishes, not only the ones loaded so far.
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let observer: PerformanceObserver | undefined;
    let stopped = false;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        if (stopped) return;
        const warm = (urls: string[]) => registration.active?.postMessage({ type: "warm", urls });
        warm([window.location.href]);
        // `buffered` replays every resource loaded so far, then each new one as it finishes.
        observer = new PerformanceObserver((list) => warm(list.getEntries().map((entry) => entry.name)));
        observer.observe({ type: "resource", buffered: true });
      })
      .catch(() => {
        // Without a service worker the site still works online; it just cannot open offline.
      });
    return () => {
      stopped = true;
      observer?.disconnect();
    };
  }, []);
  return null;
}

// "Install Labelhand" appears only when the browser offers to install the app.
export function InstallButton({ className = "" }: { className?: string }) {
  const [offer, setOffer] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const onOffer = (event: Event) => {
      event.preventDefault();
      setOffer(event as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onOffer);
    return () => window.removeEventListener("beforeinstallprompt", onOffer);
  }, []);
  if (!offer) return null;
  return (
    <button
      type="button"
      className={className}
      data-install
      onClick={async () => {
        await offer.prompt();
        await offer.userChoice;
        setOffer(null);
      }}
    >
      Install Labelhand on this device
    </button>
  );
}
