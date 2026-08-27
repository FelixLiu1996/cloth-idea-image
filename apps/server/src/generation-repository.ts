import type {
  ApiErrorResponse,
  GenerationApiResponse,
  GenerationJobStatusResponse,
  SupportedImageMimeType,
} from "@cloth-idea/domain";

export interface StoredGenerationRecord {
  readonly response: GenerationApiResponse;
  readonly assetFileName: string;
  readonly assetMimeType: SupportedImageMimeType;
  readonly basePrompt: string;
  readonly baseSummary: string;
  readonly baseRequestFingerprint: string;
  readonly sourceImageSha256: string;
  readonly revisionInstructions: readonly string[];
}

interface IdempotentJob {
  readonly requestFingerprint: string;
  readonly jobId: string;
}

export interface EnqueueGenerationJobInput {
  readonly jobId: string;
  readonly statusUrl: string;
  readonly createdAt: string;
  readonly idempotencyKey: string | undefined;
  readonly requestFingerprint: string;
  readonly onAccepted?: () => void;
  readonly operation: () => Promise<StoredGenerationRecord>;
  readonly mapError: (error: unknown) => ApiErrorResponse;
}

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super("同一个幂等键不能用于不同的生成请求。");
    this.name = "IdempotencyKeyConflictError";
  }
}

export class GenerationResultRepository {
  private readonly recordsByJobId = new Map<string, StoredGenerationRecord>();
  private readonly jobsById = new Map<string, GenerationJobStatusResponse>();
  private readonly jobsByIdempotencyKey = new Map<string, IdempotentJob>();

  save(record: StoredGenerationRecord): void {
    this.recordsByJobId.set(record.response.jobId, record);
    this.jobsById.set(record.response.jobId, record.response);
  }

  get(jobId: string): StoredGenerationRecord | null {
    return this.recordsByJobId.get(jobId) ?? null;
  }

  getJob(jobId: string): GenerationJobStatusResponse | null {
    return this.jobsById.get(jobId) ?? null;
  }

  enqueueOnce(input: EnqueueGenerationJobInput): {
    readonly job: GenerationJobStatusResponse;
    readonly reused: boolean;
  } {
    if (input.idempotencyKey) {
      const existingJob = this.jobsByIdempotencyKey.get(input.idempotencyKey);
      if (existingJob) {
        if (existingJob.requestFingerprint !== input.requestFingerprint) {
          throw new IdempotencyKeyConflictError();
        }
        const existingStatus = this.jobsById.get(existingJob.jobId);
        if (!existingStatus) {
          throw new Error("幂等任务状态不存在。");
        }
        return { job: existingStatus, reused: true };
      }
    }

    input.onAccepted?.();

    const queuedJob: GenerationJobStatusResponse = {
      jobId: input.jobId,
      status: "queued",
      statusUrl: input.statusUrl,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.jobsById.set(input.jobId, queuedJob);
    if (input.idempotencyKey) {
      this.jobsByIdempotencyKey.set(input.idempotencyKey, {
        requestFingerprint: input.requestFingerprint,
        jobId: input.jobId,
      });
    }

    setImmediate(() => {
      const generatingAt = new Date().toISOString();
      this.jobsById.set(input.jobId, {
        ...queuedJob,
        status: "generating",
        updatedAt: generatingAt,
      });

      void input
        .operation()
        .then((record) => {
          this.save(record);
        })
        .catch((error: unknown) => {
          this.jobsById.set(input.jobId, {
            jobId: input.jobId,
            status: "failed",
            error: input.mapError(error),
            createdAt: input.createdAt,
            updatedAt: new Date().toISOString(),
          });
        });
    });

    return { job: queuedJob, reused: false };
  }
}
