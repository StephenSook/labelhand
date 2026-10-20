import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Labelhand",
    short_name: "Labelhand",
    description: "Check every EPA label in the tank against the NWS hourly forecast, one hour at a time.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#fbf7ee",
    theme_color: "#2f8f4e",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
