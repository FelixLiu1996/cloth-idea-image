import type {
  GarmentAnalysisApiResponse,
  GenerationJobStatusResponse,
  SupportedImageMimeType,
} from "@cloth-idea/domain";

export interface GarmentAnalysisRecord {
  readonly analysisId: string;
  readonly ownerId: string;
  readonly response: GarmentAnalysisApiResponse;
  readonly sourceImageSha256: string;
  readonly expiresAt: string;
}

export interface GarmentAnalysisRepository {
  findById(ownerId: string, analysisId: string, now: string): Promise<GarmentAnalysisRecord | null>;
  save(record: GarmentAnalysisRecord): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}

export type GenerationTaskAction = "generation" | "refinement";

export interface GenerationTaskExecutionLease {
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
  readonly attempt: number;
  readonly providerCallStartedAt: string | null;
}

export interface GenerationTaskRecord {
  readonly jobId: string;
  readonly ownerId: string;
  readonly action: GenerationTaskAction;
  readonly requestFingerprint: string;
  /**
   * Opaque server-side input required to execute a queued task after admission.
   * The owning runtime must validate this value before use.
   */
  readonly executionPayload: unknown | null;
  readonly status: GenerationJobStatusResponse;
  readonly execution: GenerationTaskExecutionLease | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface GenerationTaskRepository {
  findById(ownerId: string, jobId: string, now: string): Promise<GenerationTaskRecord | null>;
  create(record: GenerationTaskRecord): Promise<boolean>;
  update(record: GenerationTaskRecord): Promise<boolean>;
  deleteExpired(now: string): Promise<number>;
}

export type IdempotencyAction = "analysis" | GenerationTaskAction;

export interface IdempotencyRecord {
  readonly ownerId: string;
  readonly action: IdempotencyAction;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly resourceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface IdempotencyRepository {
  find(
    ownerId: string,
    action: IdempotencyAction,
    key: string,
    now: string,
  ): Promise<IdempotencyRecord | null>;
  create(record: IdempotencyRecord): Promise<boolean>;
  deleteExpired(now: string): Promise<number>;
}

export type TrialQuotaKind = "analysis" | "generation";
export type TrialQuotaScope = "user" | "global";

export interface TrialQuotaReservation {
  readonly scope: TrialQuotaScope;
  readonly subjectId: string;
  readonly kind: TrialQuotaKind;
  readonly day: string;
  readonly amount: number;
  readonly limit: number;
}

export interface TrialQuotaSnapshot {
  readonly scope: TrialQuotaScope;
  readonly subjectId: string;
  readonly kind: TrialQuotaKind;
  readonly day: string;
  readonly used: number;
  readonly limit: number;
}

export type TrialQuotaReservationResult =
  | {
      readonly allowed: true;
      readonly snapshots: readonly TrialQuotaSnapshot[];
    }
  | {
      readonly allowed: false;
      readonly denied: TrialQuotaSnapshot;
      readonly snapshots: readonly TrialQuotaSnapshot[];
    };

export interface TrialQuotaRepository {
  reserveMany(reservations: readonly TrialQuotaReservation[]): Promise<TrialQuotaReservationResult>;
  getUsage(
    scope: TrialQuotaScope,
    subjectId: string,
    kind: TrialQuotaKind,
    day: string,
  ): Promise<number>;
}

export type GarmentAssetKind = "source" | "result";

export interface GarmentAssetRecord {
  readonly assetId: string;
  readonly ownerId: string;
  readonly kind: GarmentAssetKind;
  readonly fileId: string;
  readonly mimeType: SupportedImageMimeType;
  readonly size: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface GarmentAssetRepository {
  findById(ownerId: string, assetId: string, now: string): Promise<GarmentAssetRecord | null>;
  findExpired(now: string, limit: number): Promise<readonly GarmentAssetRecord[]>;
  hasActiveFileReference(fileId: string, now: string): Promise<boolean>;
  save(record: GarmentAssetRecord): Promise<void>;
  delete(ownerId: string, assetId: string): Promise<boolean>;
}

export interface ApplicationTransactionRunner {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
