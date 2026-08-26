import type { GenerationApiResponse } from "@cloth-idea/domain";

export class GenerationResultRepository {
  private readonly executionsByIdempotencyKey = new Map<string, Promise<GenerationApiResponse>>();

  async executeOnce(
    key: string | undefined,
    operation: () => Promise<GenerationApiResponse>,
  ): Promise<{ result: GenerationApiResponse; reused: boolean }> {
    if (!key) {
      return { result: await operation(), reused: false };
    }

    const existingExecution = this.executionsByIdempotencyKey.get(key);
    if (existingExecution) {
      return { result: await existingExecution, reused: true };
    }

    const execution = operation();
    this.executionsByIdempotencyKey.set(key, execution);

    try {
      return { result: await execution, reused: false };
    } catch (error) {
      if (this.executionsByIdempotencyKey.get(key) === execution) {
        this.executionsByIdempotencyKey.delete(key);
      }
      throw error;
    }
  }
}
