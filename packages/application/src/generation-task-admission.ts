import type { GenerationJobPendingResponse } from "@cloth-idea/domain";

import {
  ApplicationStateConflictError,
  IdempotencyConflictError,
  TrialQuotaExceededError,
} from "./errors";
import type {
  ApplicationTransactionRunner,
  GenerationTaskAction,
  GenerationTaskRecord,
  GenerationTaskRepository,
  IdempotencyRepository,
  TrialQuotaRepository,
  TrialQuotaReservation,
} from "./ports";

export interface AdmitGenerationTaskInput {
  readonly ownerId: string;
  readonly action: GenerationTaskAction;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly jobId: string;
  readonly statusUrl: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly quotaReservations: readonly TrialQuotaReservation[];
}

export interface AdmitGenerationTaskResult {
  readonly task: GenerationTaskRecord;
  readonly reused: boolean;
}

export interface GenerationTaskAdmissionDependencies {
  readonly transactions: ApplicationTransactionRunner;
  readonly tasks: GenerationTaskRepository;
  readonly idempotency: IdempotencyRepository;
  readonly quotas: TrialQuotaRepository;
}

export class GenerationTaskAdmissionService {
  constructor(private readonly dependencies: GenerationTaskAdmissionDependencies) {}

  async admit(input: AdmitGenerationTaskInput): Promise<AdmitGenerationTaskResult> {
    return this.dependencies.transactions.run(async () => {
      const existingIdempotency = await this.dependencies.idempotency.find(
        input.ownerId,
        input.action,
        input.idempotencyKey,
        input.createdAt,
      );
      if (existingIdempotency) {
        if (existingIdempotency.requestFingerprint !== input.requestFingerprint) {
          throw new IdempotencyConflictError();
        }
        const existingTask = await this.dependencies.tasks.findById(
          input.ownerId,
          existingIdempotency.resourceId,
          input.createdAt,
        );
        if (!existingTask) {
          throw new ApplicationStateConflictError("幂等记录绑定的生成任务不存在或已经过期。");
        }
        return { task: existingTask, reused: true };
      }

      const quotaResult = await this.dependencies.quotas.reserveMany(input.quotaReservations);
      if (!quotaResult.allowed) {
        throw new TrialQuotaExceededError(quotaResult.denied);
      }

      const queuedStatus: GenerationJobPendingResponse = {
        jobId: input.jobId,
        status: "queued",
        statusUrl: input.statusUrl,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      const task: GenerationTaskRecord = {
        jobId: input.jobId,
        ownerId: input.ownerId,
        action: input.action,
        requestFingerprint: input.requestFingerprint,
        status: queuedStatus,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt,
      };
      if (!(await this.dependencies.tasks.create(task))) {
        throw new ApplicationStateConflictError("生成任务编号已经存在。");
      }
      if (
        !(await this.dependencies.idempotency.create({
          ownerId: input.ownerId,
          action: input.action,
          key: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          resourceId: input.jobId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        }))
      ) {
        throw new ApplicationStateConflictError("幂等记录已经存在。");
      }

      return { task, reused: false };
    });
  }
}
