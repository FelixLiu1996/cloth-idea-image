import {
  GenerationTaskAdmissionService,
  MemoryGenerationTaskRepository,
  MemoryIdempotencyRepository,
  MemoryTransactionRunner,
  MemoryTrialQuotaRepository,
  type GenerationTaskAction,
  type GenerationTaskAdmissionDependencies,
  type GenerationTaskRecord,
} from "@cloth-idea/application";
import type {
  ApiErrorResponse,
  GenerationApiResponse,
  GenerationJobStatusResponse,
  SupportedImageMimeType,
} from "@cloth-idea/domain";

const localOwnerId = "local-trial";
const localTaskExpiry = "9999-12-31T23:59:59.999Z";

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

export interface EnqueueGenerationJobInput {
  readonly jobId: string;
  readonly action: GenerationTaskAction;
  readonly statusUrl: string;
  readonly createdAt: string;
  readonly idempotencyKey: string | undefined;
  readonly requestFingerprint: string;
  readonly operation: () => Promise<StoredGenerationRecord>;
  readonly mapError: (error: unknown) => ApiErrorResponse;
}

export interface GenerationResultRepositoryOptions {
  readonly ownerId?: string;
  readonly dailyGenerationLimit?: number;
  readonly admissionDependencies?: GenerationTaskAdmissionDependencies;
}

function createMemoryAdmissionDependencies(): GenerationTaskAdmissionDependencies {
  const tasks = new MemoryGenerationTaskRepository();
  const idempotency = new MemoryIdempotencyRepository();
  const quotas = new MemoryTrialQuotaRepository();
  return {
    tasks,
    idempotency,
    quotas,
    transactions: new MemoryTransactionRunner([tasks, idempotency, quotas]),
  };
}

export class GenerationResultRepository {
  private readonly recordsByJobId = new Map<string, StoredGenerationRecord>();
  private readonly ownerId: string;
  private readonly dailyGenerationLimit: number;
  private readonly dependencies: GenerationTaskAdmissionDependencies;
  private readonly admission: GenerationTaskAdmissionService;

  constructor(options: GenerationResultRepositoryOptions = {}) {
    this.ownerId = options.ownerId ?? localOwnerId;
    this.dailyGenerationLimit = options.dailyGenerationLimit ?? 0;
    this.dependencies = options.admissionDependencies ?? createMemoryAdmissionDependencies();
    this.admission = new GenerationTaskAdmissionService(this.dependencies);
  }

  get(jobId: string): StoredGenerationRecord | null {
    return this.recordsByJobId.get(jobId) ?? null;
  }

  async getJob(jobId: string): Promise<GenerationJobStatusResponse | null> {
    const task = await this.dependencies.tasks.findById(
      this.ownerId,
      jobId,
      new Date().toISOString(),
    );
    return task?.status ?? null;
  }

  async enqueueOnce(input: EnqueueGenerationJobInput): Promise<{
    readonly job: GenerationJobStatusResponse;
    readonly reused: boolean;
  }> {
    const admitted = await this.admission.admit({
      ownerId: this.ownerId,
      action: input.action,
      // Fastify historically shared one namespace between initial and refinement keys.
      idempotencyAction: "generation",
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      jobId: input.jobId,
      statusUrl: input.statusUrl,
      createdAt: input.createdAt,
      expiresAt: localTaskExpiry,
      quotaReservations: [
        {
          scope: "global",
          subjectId: localOwnerId,
          kind: "generation",
          day: input.createdAt.slice(0, 10),
          amount: 1,
          limit: this.dailyGenerationLimit,
        },
      ],
    });

    if (!admitted.reused) {
      this.scheduleOperation(admitted.task, input);
    }
    return { job: admitted.task.status, reused: admitted.reused };
  }

  private scheduleOperation(task: GenerationTaskRecord, input: EnqueueGenerationJobInput): void {
    setImmediate(() => {
      void this.runOperation(task, input);
    });
  }

  private async runOperation(
    queuedTask: GenerationTaskRecord,
    input: EnqueueGenerationJobInput,
  ): Promise<void> {
    const generatingAt = new Date().toISOString();
    await this.dependencies.tasks.update({
      ...queuedTask,
      status: {
        jobId: input.jobId,
        status: "generating",
        statusUrl: input.statusUrl,
        createdAt: input.createdAt,
        updatedAt: generatingAt,
      },
      updatedAt: generatingAt,
    });

    try {
      const record = await input.operation();
      this.recordsByJobId.set(record.response.jobId, record);
      await this.dependencies.tasks.update({
        ...queuedTask,
        status: record.response,
        updatedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const failedAt = new Date().toISOString();
      await this.dependencies.tasks.update({
        ...queuedTask,
        status: {
          jobId: input.jobId,
          status: "failed",
          error: input.mapError(error),
          createdAt: input.createdAt,
          updatedAt: failedAt,
        },
        updatedAt: failedAt,
      });
    }
  }
}
