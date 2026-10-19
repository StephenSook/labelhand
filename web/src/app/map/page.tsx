import type { Metadata } from "next";
import { Nav } from "@/ui";
import { SprayMap } from "@/ui/map/SprayMap";

export const metadata: Metadata = {
  title: "Where can I spray?", // the root layout's template appends "| Labelhand"
  description: "Every south Georgia field checked against the NWS hourly forecast for one tank, on one map.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MapPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  return (
    <>
      <Nav />
      <SprayMap
        initialMode={first(query.mode)}
        initialDay={first(query.day)}
        initialHours={first(query.hours)}
        initialProducts={first(query.products)}
        initialAhead={first(query.ahead)}
      />
    </>
  );
}
