import type { Metadata } from "next";
import { Nav } from "@/ui";
import { Planner } from "@/ui/planner/Planner";

export const metadata: Metadata = {
  title: "Check a tank", // the root layout's template appends "| Labelhand"
  description: "Check three EPA cotton defoliation labels against an NWS hourly forecast.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AppPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  return (
    <>
      <Nav />
      <Planner
        initialField={first(query.field)}
        initialProducts={first(query.products) ?? first(query.tank)}
        initialHours={first(query.hours)}
        initialReplay={first(query.replay)}
      />
    </>
  );
}
