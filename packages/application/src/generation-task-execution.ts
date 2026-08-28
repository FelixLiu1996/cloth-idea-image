import type {
  ApiErrorResponse,
  GenerationJobFailedResponse,
  GenerationJobStatusResponse,
} from "@cloth-idea/domain";

import { ApplicationStateConflictError } from "./errors";
import type {
  ApplicationTransactionRunner,
  GenerationTaskRecord,
  GenerationTaskRepository,
} from "./ports";

export interface ClaimGenerationTaskInput {
  readonly ownerId: string;
  readonly jobId: string;
  readonly leaseId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
  readonly interruptedError: ApiErrorResponse;
}

export interface MutateGenerationTaskExecutionInput {
  readonly ownerId: string;
  readonly jobId: string;
  readonly leaseId: string;
  readonly now: string;
}

export interface RecoverGenerationTaskInput {
  readonly ownerId: string;
  readonly jobId: string;
  readonly now: string;
  readonly interruptedError: ApiErrorResponse;
}

export interface CompleteGenerationTaskInput extends MutateGenerationTaskExecutionInput {
  readonly status: GenerationJobStatusResponse;
}

export interface GenerationTaskExecutionDependencies {
  readonly transactions: ApplicationTransactionRunner;
  readonly tasks: GenerationTaskRepository;
}

function isTerminal(task: GenerationTaskRecord): boolean {
  return task.status.status === "succeeded" || task.status.status === "failed";
}

function isActiveLease(task: GenerationTaskRecord, now: string): boolean {
  return Boolean(task.execution && Date.parse(task.execution.leaseExpiresAt) > Date.parse(now));
}

export class GenerationTaskExecutionService {
  constructor(private readonly dependencies: GenerationTaskExecutionDependencies) {}

  async claim(input: ClaimGenerationTaskInput): Promise<{
    readonly task: GenerationTaskRecord;
    readonly claimed: boolean;
  }> {
    return this.dependencies.transactions.run(async () => {
      const task = await this.requireTask(input.ownerId, input.jobId, input.now);
      if (isTerminal(task) || isActiveLease(task, input.now)) {
        return { task, claimed: false };
      }

      const interrupted = await this.interruptIfUnsafe(task, input);
      if (interrupted) {
        return { task: interrupted, claimed: false };
      }

      const claimed: GenerationTaskRecord = {
        ...task,
        status: {
          jobId: task.jobId,
          status: "generating",
          statusUrl:
            task.status.status === "queued" || task.status.status === "generating"
              ? task.status.statusUrl
              : `wechat-cloud://generation-jobs/${task.jobId}`,
          createdAt: task.createdAt,
          updatedAt: input.now,
        },
        execution: {
          leaseId: input.leaseId,
          leaseExpiresAt: input.leaseExpiresAt,
          attempt: (task.execution?.attempt ?? 0) + 1,
          providerCallStartedAt: null,
        },
        updatedAt: input.now,
      };
      await this.updateOrThrow(claimed);
      return { task: claimed, claimed: true };
    });
  }

  async recoverExpiredStartedCall(
    input: RecoverGenerationTaskInput,
  ): Promise<GenerationTaskRecord> {
    return this.dependencies.transactions.run(async () => {
      const task = await this.requireTask(input.ownerId, input.jobId, input.now);
      if (isTerminal(task) || isActiveLease(task, input.now)) {
        return task;
      }
      return (await this.interruptIfUnsafe(task, input)) ?? task;
    });
  }

  async markProviderCallStarted(
    input: MutateGenerationTaskExecutionInput,
  ): Promise<GenerationTaskRecord> {
    return this.dependencies.transactions.run(async () => {
      const task = await this.requireTask(input.ownerId, input.jobId, input.now);
      this.assertLease(task, input.leaseId);
      const updated: GenerationTaskRecord = {
        ...task,
        execution: { ...task.execution!, providerCallStartedAt: input.now },
        updatedAt: input.now,
      };
      await this.updateOrThrow(updated);
      return updated;
    });
  }

  async complete(input: CompleteGenerationTaskInput): Promise<GenerationTaskRecord> {
    return this.dependencies.transactions.run(async () => {
      const task = await this.requireTask(input.ownerId, input.jobId, input.now);
      this.assertLease(task, input.leaseId);
      if (input.status.jobId !== task.jobId) {
        throw new ApplicationStateConflictError("任务结果与执行租约不匹配。");
      }
      if (input.status.status !== "succeeded" && input.status.status !== "failed") {
        throw new ApplicationStateConflictError("任务执行租约只能提交终态结果。");
      }
      const completed = { ...task, status: input.status, updatedAt: input.now };
      await this.updateOrThrow(completed);
      return completed;
    });
  }

  private async requireTask(
    ownerId: string,
    jobId: string,
    now: string,
  ): Promise<GenerationTaskRecord> {
    const task = await this.dependencies.tasks.findById(ownerId, jobId, now);
    if (!task) {
      throw new ApplicationStateConflictError("生成任务不存在或已经过期。");
    }
    return task;
  }

  private assertLease(task: GenerationTaskRecord, leaseId: string): void {
    if (!task.execution || task.execution.leaseId !== leaseId || isTerminal(task)) {
      throw new ApplicationStateConflictError("生成任务执行租约已经失效。");
    }
  }

  private async interruptIfUnsafe(
    task: GenerationTaskRecord,
    input: RecoverGenerationTaskInput,
  ): Promise<GenerationTaskRecord | null> {
    if (
      !task.execution?.providerCallStartedAt &&
      !(task.status.status === "generating" && task.execution === null)
    ) {
      return null;
    }
    const failed: GenerationJobFailedResponse = {
      jobId: task.jobId,
      status: "failed",
      error: input.interruptedError,
      createdAt: task.createdAt,
      updatedAt: input.now,
    };
    const interrupted = { ...task, status: failed, updatedAt: input.now };
    await this.updateOrThrow(interrupted);
    return interrupted;
  }

  private async updateOrThrow(task: GenerationTaskRecord): Promise<void> {
    if (!(await this.dependencies.tasks.update(task))) {
      throw new ApplicationStateConflictError("生成任务状态更新失败。");
    }
  }
}
