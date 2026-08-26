import type { GenerationApiResponse, SupportedImageMimeType } from "@cloth-idea/domain";

export interface StoredGenerationRecord {
  readonly response: GenerationApiResponse;
  readonly assetFileName: string;
  readonly assetMimeType: SupportedImageMimeType;
  readonly basePrompt: string;
  readonly baseSummary: string;
  readonly baseRequestFingerprint: string;
  readonly revisionInstructions: readonly string[];
}

interface IdempotentExecution {
  readonly requestFingerprint: string;
  readonly promise: Promise<GenerationApiResponse>;
}

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super("同一个幂等键不能用于不同的生成请求。");
    this.name = "IdempotencyKeyConflictError";
  }
}

export class GenerationResultRepository {
  private readonly recordsByJobId = new Map<string, StoredGenerationRecord>();
  private readonly executionsByIdempotencyKey = new Map<string, IdempotentExecution>();

  save(record: StoredGenerationRecord): void {
    this.recordsByJobId.set(record.response.jobId, record);
  }

  get(jobId: string): StoredGenerationRecord | null {
    return this.recordsByJobId.get(jobId) ?? null;
  }

  async executeOnce(
    key: string | undefined,
    requestFingerprint: string,
    operation: () => Promise<GenerationApiResponse>,
  ): Promise<{ result: GenerationApiResponse; reused: boolean }> {
    if (!key) {
      return { result: await operation(), reused: false };
    }

    const existingExecution = this.executionsByIdempotencyKey.get(key);
    if (existingExecution) {
      if (existingExecution.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyKeyConflictError();
      }
      return { result: await existingExecution.promise, reused: true };
    }

    const execution = operation();
    this.executionsByIdempotencyKey.set(key, {
      requestFingerprint,
      promise: execution,
    });

    try {
      return { result: await execution, reused: false };
    } catch (error) {
      if (this.executionsByIdempotencyKey.get(key)?.promise === execution) {
        this.executionsByIdempotencyKey.delete(key);
      }
      throw error;
    }
  }
}
