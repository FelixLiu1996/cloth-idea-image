export type TrialUsageLimitCode = "RATE_LIMIT_DAILY_ANALYSIS_REACHED";

export class TrialUsageLimitError extends Error {
  readonly statusCode = 429;
  readonly retryable = false;

  constructor(
    readonly code: TrialUsageLimitCode,
    message: string,
  ) {
    super(message);
    this.name = "TrialUsageLimitError";
  }
}

export interface TrialUsagePolicyConfig {
  readonly dailyAnalysisLimit: number;
  readonly maxConcurrentModelRequests: number;
  readonly generationMinIntervalMs: number;
}

interface DailyUsage {
  day: string;
  analyses: number;
}

function currentUtcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class TrialUsagePolicy {
  private usage: DailyUsage = {
    day: currentUtcDay(Date.now()),
    analyses: 0,
  };
  private activeModelRequests = 0;
  private readonly concurrencyWaiters: Array<() => void> = [];
  private nextGenerationStartAt = 0;
  private generationStartSchedule: Promise<void> = Promise.resolve();

  constructor(private readonly config: TrialUsagePolicyConfig) {}

  reserveAnalysis(now = Date.now()): void {
    this.resetDailyUsageIfNeeded(now);
    if (
      this.config.dailyAnalysisLimit > 0 &&
      this.usage.analyses >= this.config.dailyAnalysisLimit
    ) {
      throw new TrialUsageLimitError(
        "RATE_LIMIT_DAILY_ANALYSIS_REACHED",
        "今日服装分析额度已用完，请明天再试或调整试用额度。",
      );
    }
    this.usage.analyses += 1;
  }

  async runAnalysis<T>(operation: () => Promise<T>): Promise<T> {
    return this.runWithConcurrencySlot(operation);
  }

  async runGeneration<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireConcurrencySlot();
    try {
      await this.scheduleGenerationStart();
      return await operation();
    } finally {
      this.releaseConcurrencySlot();
    }
  }

  private resetDailyUsageIfNeeded(now: number): void {
    const day = currentUtcDay(now);
    if (this.usage.day !== day) {
      this.usage = { day, analyses: 0 };
    }
  }

  private async scheduleGenerationStart(): Promise<void> {
    const scheduled = this.generationStartSchedule.then(async () => {
      const delayMs = Math.max(0, this.nextGenerationStartAt - Date.now());
      if (delayMs > 0) {
        await wait(delayMs);
      }
      this.nextGenerationStartAt = Date.now() + this.config.generationMinIntervalMs;
    });
    this.generationStartSchedule = scheduled.catch(() => undefined);
    await scheduled;
  }

  private async runWithConcurrencySlot<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireConcurrencySlot();
    try {
      return await operation();
    } finally {
      this.releaseConcurrencySlot();
    }
  }

  private async acquireConcurrencySlot(): Promise<void> {
    if (this.activeModelRequests < this.config.maxConcurrentModelRequests) {
      this.activeModelRequests += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.concurrencyWaiters.push(resolve);
    });
  }

  private releaseConcurrencySlot(): void {
    const next = this.concurrencyWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeModelRequests -= 1;
  }
}
