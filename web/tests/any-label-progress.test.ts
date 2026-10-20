import { describe, expect, test } from "vitest";
import type { CompiledLiveLabel, PipelineEvent } from "@/lib/compiler/pipeline";
import { EMPTY_PROGRESS, advance, readingVote } from "@/ui/planner/AnyLabel";

const page = (reading: number, attempt: number, accepted: number): PipelineEvent =>
  ({ type: "page", n: 1, of: 4, accepted, rejected: 0, reading, attempt });

describe("live label progress", () => {
  test("counts each reading on its own and restarts a reading on its retry", () => {
    let progress = EMPTY_PROGRESS;
    for (const event of [page(1, 1, 3), page(2, 1, 2), page(1, 1, 1), page(1, 2, 5), page(3, 1, 4)]) {
      progress = advance(progress, event);
    }
    expect(progress.readings[1]).toMatchObject({ attempt: 2, pagesDone: 1, kept: 5 });
    expect(progress.readings[2]).toMatchObject({ attempt: 1, pagesDone: 1, kept: 2 });
    expect(progress.readings[3]).toMatchObject({ attempt: 1, pagesDone: 1, kept: 4 });
  });

  test("an event without a reading number counts as reading 1", () => {
    const progress = advance(EMPTY_PROGRESS, { type: "page", n: 1, of: 2, accepted: 2, rejected: 1 });
    expect(progress.readings[1]).toMatchObject({ pagesDone: 1, kept: 2, rejected: 1 });
  });

  test("the vote line names each reading's count and the merged result", () => {
    const label = {
      reading_records: [3, 1, 2].map((reading) => ({ reading, accepted_rules: reading * 10 })),
      accepted: [
        { found_in_runs: ["reading-1", "reading-2", "reading-3"] },
        { found_in_runs: ["reading-2"] },
      ],
    } as unknown as CompiledLiveLabel;
    expect(readingVote(label)).toBe("Read three times: 10, 20 and 30 rules. 2 kept after merging, 1 found in every reading.");
  });
});
