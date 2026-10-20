"use client";

import { useEffect, useState } from "react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

// Registers the service worker in production builds and hands it the URLs this page already
// loaded, so the first visit is enough for the app to open with no signal.
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        const urls = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .concat(window.location.href);
        registration.active?.postMessage({ type: "warm", urls });
      })
      .catch(() => {
        // Without a service worker the site still works online; it just cannot open offline.
      });
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
