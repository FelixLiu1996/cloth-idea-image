import type { TrialQuotaSnapshot } from "./ports";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("同一个幂等键不能用于不同的请求。");
    this.name = "IdempotencyConflictError";
  }
}

export class TrialQuotaExceededError extends Error {
  readonly code = "RATE_LIMIT_DAILY_QUOTA_REACHED";

  constructor(readonly denied: TrialQuotaSnapshot) {
    super("今日试用额度已用完，请明天再试或调整试用额度。");
    this.name = "TrialQuotaExceededError";
  }
}

export class ApplicationStateConflictError extends Error {
  readonly code = "APPLICATION_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ApplicationStateConflictError";
  }
}
