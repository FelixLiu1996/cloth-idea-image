import { afterEach, describe, expect, it, vi } from "vitest";

import { TrialUsageLimitError, TrialUsagePolicy } from "./trial-usage-policy";

function createPolicy(
  overrides: Partial<ConstructorParameters<typeof TrialUsagePolicy>[0]> = {},
): TrialUsagePolicy {
  return new TrialUsagePolicy({
    dailyAnalysisLimit: 2,
    maxConcurrentModelRequests: 1,
    generationMinIntervalMs: 0,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TrialUsagePolicy", () => {
  it("enforces the daily analysis limit", () => {
    const policy = createPolicy({ dailyAnalysisLimit: 1 });

    policy.reserveAnalysis();

    expect(() => policy.reserveAnalysis()).toThrowError(
      expect.objectContaining<Partial<TrialUsageLimitError>>({
        code: "RATE_LIMIT_DAILY_ANALYSIS_REACHED",
      }),
    );
  });

  it("serializes model operations at the configured concurrency", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const policy = createPolicy();
    const starts: string[] = [];

    const first = policy.runAnalysis(async () => {
      starts.push("first");
      await firstGate;
      return "first-result";
    });
    const second = policy.runAnalysis(async () => {
      starts.push("second");
      return "second-result";
    });

    await vi.waitFor(() => expect(starts).toEqual(["first"]));
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first-result", "second-result"]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("paces generation starts without delaying the first request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const policy = createPolicy({
      maxConcurrentModelRequests: 2,
      generationMinIntervalMs: 31_000,
    });
    const starts: number[] = [];

    const first = policy.runGeneration(async () => {
      starts.push(Date.now());
    });
    const second = policy.runGeneration(async () => {
      starts.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([Date.parse("2026-08-27T12:00:00.000Z")]);
    await vi.advanceTimersByTimeAsync(31_000);
    await Promise.all([first, second]);

    const [firstStart, secondStart] = starts;
    expect(firstStart).toBeDefined();
    expect(secondStart).toBeDefined();
    expect((secondStart ?? 0) - (firstStart ?? 0)).toBe(31_000);
  });
});
