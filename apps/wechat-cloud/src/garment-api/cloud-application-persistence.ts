import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type {
  ApplicationTransactionRunner,
  GarmentAnalysisRecord,
  GarmentAnalysisRepository,
  GarmentAssetRecord,
  GarmentAssetRepository,
  GenerationTaskRecord,
  GenerationTaskRepository,
  IdempotencyAction,
  IdempotencyRecord,
  IdempotencyRepository,
  TrialQuotaKind,
  TrialQuotaRepository,
  TrialQuotaReservation,
  TrialQuotaReservationResult,
  TrialQuotaScope,
  TrialQuotaSnapshot,
  GenerationTaskExecutionLease,
} from "@cloth-idea/application";
import {
  garmentAnalysisSchema,
  supportedImageMimeTypes,
  type GarmentAnalysisApiResponse,
  type GenerationJobStatusResponse,
} from "@cloth-idea/domain";

export const applicationCollectionNames = {
  analyses: "garment_analyses",
  assets: "garment_assets",
  generationTasks: "generation_jobs",
  idempotency: "idempotency_records",
  trialUsage: "trial_usage",
} as const;

interface WechatGetResult {
  readonly data?: unknown;
}

export interface WechatCloudDocumentReference {
  get(): Promise<WechatGetResult>;
  set(input: { readonly data: object }): Promise<unknown>;
  remove(): Promise<unknown>;
}

export interface WechatCloudQuery {
  where(condition: Readonly<Record<string, unknown>>): WechatCloudQuery;
  limit(count: number): WechatCloudQuery;
  get(): Promise<WechatGetResult>;
}

export interface WechatCloudCollection extends WechatCloudQuery {
  doc(id: string): WechatCloudDocumentReference;
}

export interface WechatCloudDatabaseContext {
  collection(name: string): WechatCloudCollection;
}

export interface WechatCloudDatabase extends WechatCloudDatabaseContext {
  readonly command: {
    lte(value: string): unknown;
    gt(value: string): unknown;
  };
  runTransaction<T>(
    operation: (transaction: WechatCloudDatabaseContext) => Promise<T>,
    retryTimes?: number,
  ): Promise<T>;
}

export interface WechatCloudApplicationPersistence {
  readonly transactions: ApplicationTransactionRunner;
  readonly analyses: GarmentAnalysisRepository;
  readonly assets: GarmentAssetRepository;
  readonly tasks: GenerationTaskRepository;
  readonly idempotency: IdempotencyRepository;
  readonly quotas: TrialQuotaRepository;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isMissingDocument(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return (
    error.errCode === -1 ||
    error.code === "DATABASE_REQUEST_DOCUMENT_NOT_FOUND" ||
    error.code === "DATABASE_DOCUMENT_NOT_FOUND"
  );
}

function parseErrorResponse(value: unknown): {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
} | null {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    return null;
  }
  return {
    code: value.code,
    message: value.message,
    requestId: value.requestId,
    retryable: value.retryable,
  };
}

function parseAnalysisResponse(value: unknown): GarmentAnalysisApiResponse | null {
  if (
    !isRecord(value) ||
    typeof value.analysisId !== "string" ||
    value.status !== "succeeded" ||
    (value.provider !== "alibaba-qwen-vl" && value.provider !== "testing-fake") ||
    typeof value.model !== "string" ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    !isRecord(value.evidenceSummary) ||
    !isNonNegativeInteger(value.evidenceSummary.accepted) ||
    !isNonNegativeInteger(value.evidenceSummary.needsReview) ||
    !isNonNegativeInteger(value.evidenceSummary.unknown) ||
    value.evidenceSummary.accepted +
      value.evidenceSummary.needsReview +
      value.evidenceSummary.unknown !==
      16
  ) {
    return null;
  }
  const analysis = garmentAnalysisSchema.safeParse(value.analysis);
  if (!analysis.success) {
    return null;
  }
  return {
    analysisId: value.analysisId,
    status: value.status,
    provider: value.provider,
    model: value.model,
    durationMs: value.durationMs,
    analysis: analysis.data,
    evidenceSummary: {
      accepted: value.evidenceSummary.accepted,
      needsReview: value.evidenceSummary.needsReview,
      unknown: value.evidenceSummary.unknown,
    },
  };
}

function parseAnalysisRecord(value: unknown): GarmentAnalysisRecord | null {
  if (
    !isRecord(value) ||
    typeof value.analysisId !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.sourceImageSha256 !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  const response = parseAnalysisResponse(value.response);
  if (!response || response.analysisId !== value.analysisId) {
    return null;
  }
  return {
    analysisId: value.analysisId,
    ownerId: value.ownerId,
    response,
    sourceImageSha256: value.sourceImageSha256,
    expiresAt: value.expiresAt,
  };
}

const supportedMimeTypes = new Set<string>(supportedImageMimeTypes);

function parseAssetRecord(value: unknown): GarmentAssetRecord | null {
  if (
    !isRecord(value) ||
    typeof value.assetId !== "string" ||
    typeof value.ownerId !== "string" ||
    (value.kind !== "source" && value.kind !== "result") ||
    typeof value.fileId !== "string" ||
    !value.fileId.startsWith("cloud://") ||
    typeof value.mimeType !== "string" ||
    !supportedMimeTypes.has(value.mimeType) ||
    typeof value.size !== "number" ||
    !Number.isInteger(value.size) ||
    value.size < 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  return {
    assetId: value.assetId,
    ownerId: value.ownerId,
    kind: value.kind,
    fileId: value.fileId,
    mimeType: value.mimeType as GarmentAssetRecord["mimeType"],
    size: value.size,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function parseGenerationStatus(value: unknown): GenerationJobStatusResponse | null {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  if (value.status === "queued" || value.status === "generating") {
    if (typeof value.statusUrl !== "string" || typeof value.updatedAt !== "string") {
      return null;
    }
    return {
      jobId: value.jobId,
      status: value.status,
      statusUrl: value.statusUrl,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }

  if (value.status === "failed") {
    const error = parseErrorResponse(value.error);
    if (!error || typeof value.updatedAt !== "string") {
      return null;
    }
    return {
      jobId: value.jobId,
      status: value.status,
      error,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }

  if (
    value.status !== "succeeded" ||
    (value.provider !== "alibaba-wan" &&
      value.provider !== "alibaba-qwen-image" &&
      value.provider !== "volcengine-seedream" &&
      value.provider !== "testing-fake") ||
    typeof value.model !== "string" ||
    typeof value.resultUrl !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.durationMs !== "number" ||
    (value.strategy !== "direct" && value.strategy !== "analyzed") ||
    (value.directionId !== null && typeof value.directionId !== "string") ||
    (value.directionName !== null && typeof value.directionName !== "string") ||
    (value.operation !== "initial" &&
      value.operation !== "regenerate" &&
      value.operation !== "refine") ||
    (value.parentJobId !== null && typeof value.parentJobId !== "string") ||
    (value.revisionInstruction !== null && typeof value.revisionInstruction !== "string")
  ) {
    return null;
  }
  return {
    jobId: value.jobId,
    status: value.status,
    provider: value.provider,
    model: value.model,
    resultUrl: value.resultUrl,
    summary: value.summary,
    durationMs: value.durationMs,
    strategy: value.strategy,
    directionId: value.directionId,
    directionName: value.directionName,
    operation: value.operation,
    parentJobId: value.parentJobId,
    revisionInstruction: value.revisionInstruction,
    createdAt: value.createdAt,
  };
}

function parseTask(value: unknown): GenerationTaskRecord | null {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    typeof value.ownerId !== "string" ||
    (value.action !== "generation" && value.action !== "refinement") ||
    typeof value.requestFingerprint !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  const status = parseGenerationStatus(value.status);
  if (!status) {
    return null;
  }
  let execution: GenerationTaskExecutionLease | null = null;
  if (value.execution !== undefined && value.execution !== null) {
    if (
      !isRecord(value.execution) ||
      typeof value.execution.leaseId !== "string" ||
      typeof value.execution.leaseExpiresAt !== "string" ||
      typeof value.execution.attempt !== "number" ||
      !Number.isInteger(value.execution.attempt) ||
      value.execution.attempt <= 0 ||
      (value.execution.providerCallStartedAt !== null &&
        typeof value.execution.providerCallStartedAt !== "string")
    ) {
      return null;
    }
    execution = {
      leaseId: value.execution.leaseId,
      leaseExpiresAt: value.execution.leaseExpiresAt,
      attempt: value.execution.attempt,
      providerCallStartedAt: value.execution.providerCallStartedAt,
    };
  }
  return {
    jobId: value.jobId,
    ownerId: value.ownerId,
    action: value.action,
    requestFingerprint: value.requestFingerprint,
    executionPayload: value.executionPayload ?? null,
    status,
    execution,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  };
}

function parseIdempotency(value: unknown): IdempotencyRecord | null {
  if (
    !isRecord(value) ||
    typeof value.ownerId !== "string" ||
    (value.action !== "analysis" &&
      value.action !== "generation" &&
      value.action !== "refinement") ||
    typeof value.key !== "string" ||
    typeof value.requestFingerprint !== "string" ||
    typeof value.resourceId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  return {
    ownerId: value.ownerId,
    action: value.action,
    key: value.key,
    requestFingerprint: value.requestFingerprint,
    resourceId: value.resourceId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function documentId(namespace: string, parts: readonly string[]): string {
  return `${namespace}_${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function isExpired(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

class WechatCloudTransactionScope implements ApplicationTransactionRunner {
  private readonly context = new AsyncLocalStorage<WechatCloudDatabaseContext>();

  constructor(readonly database: WechatCloudDatabase) {}

  current(): WechatCloudDatabaseContext {
    return this.context.getStore() ?? this.database;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) {
      return operation();
    }
    return this.database.runTransaction(
      (transaction) => this.context.run(transaction, operation),
      3,
    );
  }
}

abstract class WechatCloudRepositoryBase {
  constructor(protected readonly scope: WechatCloudTransactionScope) {}

  protected async read(collectionName: string, id: string): Promise<unknown | null> {
    try {
      const result = await this.scope.current().collection(collectionName).doc(id).get();
      return result.data ?? null;
    } catch (error) {
      if (isMissingDocument(error)) {
        return null;
      }
      throw error;
    }
  }

  protected async removeExpired(collectionName: string, now: string): Promise<number> {
    let removed = 0;
    for (;;) {
      const result = await this.scope
        .current()
        .collection(collectionName)
        .where({ expiresAt: this.scope.database.command.lte(now) })
        .limit(100)
        .get();
      const documents = Array.isArray(result.data) ? result.data : [];
      const ids = documents
        .map((document) => (isRecord(document) ? document._id : undefined))
        .filter((id): id is string => typeof id === "string");
      if (ids.length === 0) {
        return removed;
      }
      for (const id of ids) {
        await this.scope.current().collection(collectionName).doc(id).remove();
      }
      removed += ids.length;
      if (ids.length < 100) {
        return removed;
      }
    }
  }
}

class WechatGarmentAnalysisRepository
  extends WechatCloudRepositoryBase
  implements GarmentAnalysisRepository
{
  async findById(
    ownerId: string,
    analysisId: string,
    now: string,
  ): Promise<GarmentAnalysisRecord | null> {
    const record = parseAnalysisRecord(
      await this.read(
        applicationCollectionNames.analyses,
        documentId("analysis", [ownerId, analysisId]),
      ),
    );
    return record && !isExpired(record.expiresAt, now) ? record : null;
  }

  async save(record: GarmentAnalysisRecord): Promise<void> {
    await this.scope
      .current()
      .collection(applicationCollectionNames.analyses)
      .doc(documentId("analysis", [record.ownerId, record.analysisId]))
      .set({ data: record });
  }

  deleteExpired(now: string): Promise<number> {
    return this.removeExpired(applicationCollectionNames.analyses, now);
  }
}

class WechatGarmentAssetRepository
  extends WechatCloudRepositoryBase
  implements GarmentAssetRepository
{
  async findById(
    ownerId: string,
    assetId: string,
    now: string,
  ): Promise<GarmentAssetRecord | null> {
    const record = parseAssetRecord(
      await this.read(applicationCollectionNames.assets, documentId("asset", [ownerId, assetId])),
    );
    return record && !isExpired(record.expiresAt, now) ? record : null;
  }

  async save(record: GarmentAssetRecord): Promise<void> {
    await this.scope
      .current()
      .collection(applicationCollectionNames.assets)
      .doc(documentId("asset", [record.ownerId, record.assetId]))
      .set({ data: record });
  }

  async findExpired(now: string, limit: number): Promise<readonly GarmentAssetRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error("过期资产查询数量必须是 1 到 100 的整数。");
    }
    const result = await this.scope
      .current()
      .collection(applicationCollectionNames.assets)
      .where({ expiresAt: this.scope.database.command.lte(now) })
      .limit(limit)
      .get();
    const documents = Array.isArray(result.data) ? result.data : [];
    return documents.map((document) => {
      const record = parseAssetRecord(document);
      if (!record) {
        throw new Error("过期资产记录格式无效，已停止清理以避免误删云文件。");
      }
      return record;
    });
  }

  async hasActiveFileReference(fileId: string, now: string): Promise<boolean> {
    const result = await this.scope
      .current()
      .collection(applicationCollectionNames.assets)
      .where({ fileId, expiresAt: this.scope.database.command.gt(now) })
      .limit(1)
      .get();
    return Array.isArray(result.data) && result.data.length > 0;
  }

  async delete(ownerId: string, assetId: string): Promise<boolean> {
    const id = documentId("asset", [ownerId, assetId]);
    if (!(await this.read(applicationCollectionNames.assets, id))) {
      return false;
    }
    await this.scope.current().collection(applicationCollectionNames.assets).doc(id).remove();
    return true;
  }
}

class WechatGenerationTaskRepository
  extends WechatCloudRepositoryBase
  implements GenerationTaskRepository
{
  async findById(
    ownerId: string,
    jobId: string,
    now: string,
  ): Promise<GenerationTaskRecord | null> {
    const record = parseTask(
      await this.read(
        applicationCollectionNames.generationTasks,
        documentId("job", [ownerId, jobId]),
      ),
    );
    return record && !isExpired(record.expiresAt, now) ? record : null;
  }

  async create(record: GenerationTaskRecord): Promise<boolean> {
    const id = documentId("job", [record.ownerId, record.jobId]);
    if (await this.read(applicationCollectionNames.generationTasks, id)) {
      return false;
    }
    await this.scope
      .current()
      .collection(applicationCollectionNames.generationTasks)
      .doc(id)
      .set({ data: record });
    return true;
  }

  async update(record: GenerationTaskRecord): Promise<boolean> {
    const id = documentId("job", [record.ownerId, record.jobId]);
    if (!(await this.read(applicationCollectionNames.generationTasks, id))) {
      return false;
    }
    await this.scope
      .current()
      .collection(applicationCollectionNames.generationTasks)
      .doc(id)
      .set({ data: record });
    return true;
  }

  deleteExpired(now: string): Promise<number> {
    return this.removeExpired(applicationCollectionNames.generationTasks, now);
  }
}

class WechatIdempotencyRepository
  extends WechatCloudRepositoryBase
  implements IdempotencyRepository
{
  async find(
    ownerId: string,
    action: IdempotencyAction,
    key: string,
    now: string,
  ): Promise<IdempotencyRecord | null> {
    const record = parseIdempotency(
      await this.read(
        applicationCollectionNames.idempotency,
        documentId("idem", [ownerId, action, key]),
      ),
    );
    return record && !isExpired(record.expiresAt, now) ? record : null;
  }

  async create(record: IdempotencyRecord): Promise<boolean> {
    const id = documentId("idem", [record.ownerId, record.action, record.key]);
    if (await this.read(applicationCollectionNames.idempotency, id)) {
      return false;
    }
    await this.scope
      .current()
      .collection(applicationCollectionNames.idempotency)
      .doc(id)
      .set({ data: record });
    return true;
  }

  deleteExpired(now: string): Promise<number> {
    return this.removeExpired(applicationCollectionNames.idempotency, now);
  }
}

interface StoredQuotaUsage {
  readonly scope: TrialQuotaScope;
  readonly subjectId: string;
  readonly kind: TrialQuotaKind;
  readonly day: string;
  readonly used: number;
  readonly updatedAt: string;
}

function quotaId(
  scope: TrialQuotaScope,
  subjectId: string,
  kind: TrialQuotaKind,
  day: string,
): string {
  return documentId("quota", [scope, subjectId, kind, day]);
}

function parseQuotaUsage(value: unknown): StoredQuotaUsage | null {
  if (
    !isRecord(value) ||
    (value.scope !== "user" && value.scope !== "global") ||
    typeof value.subjectId !== "string" ||
    (value.kind !== "analysis" && value.kind !== "generation") ||
    typeof value.day !== "string" ||
    typeof value.used !== "number" ||
    !Number.isInteger(value.used) ||
    value.used < 0 ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    scope: value.scope,
    subjectId: value.subjectId,
    kind: value.kind,
    day: value.day,
    used: value.used,
    updatedAt: value.updatedAt,
  };
}

function reservationKey(reservation: TrialQuotaReservation): string {
  return JSON.stringify([
    reservation.scope,
    reservation.subjectId,
    reservation.kind,
    reservation.day,
  ]);
}

class WechatTrialQuotaRepository extends WechatCloudRepositoryBase implements TrialQuotaRepository {
  async reserveMany(
    reservations: readonly TrialQuotaReservation[],
  ): Promise<TrialQuotaReservationResult> {
    if (this.scope.current() === this.scope.database) {
      return this.scope.run(() => this.reserveMany(reservations));
    }

    const combined = new Map<string, TrialQuotaReservation>();
    for (const reservation of reservations) {
      if (!Number.isInteger(reservation.amount) || reservation.amount <= 0) {
        throw new Error("额度预占数量必须是正整数。");
      }
      if (!Number.isInteger(reservation.limit) || reservation.limit < 0) {
        throw new Error("额度上限必须是非负整数。");
      }
      const key = reservationKey(reservation);
      const existing = combined.get(key);
      if (existing && existing.limit !== reservation.limit) {
        throw new Error("同一额度维度不能使用不同的上限。");
      }
      combined.set(key, {
        ...reservation,
        amount: (existing?.amount ?? 0) + reservation.amount,
      });
    }

    const normalized = [...combined.values()];
    const usages: number[] = [];
    for (const reservation of normalized) {
      usages.push(
        await this.getUsage(
          reservation.scope,
          reservation.subjectId,
          reservation.kind,
          reservation.day,
        ),
      );
    }
    const snapshots: TrialQuotaSnapshot[] = normalized.map((reservation, index) => ({
      scope: reservation.scope,
      subjectId: reservation.subjectId,
      kind: reservation.kind,
      day: reservation.day,
      used: usages[index] ?? 0,
      limit: reservation.limit,
    }));
    const denied = snapshots.find(
      (snapshot, index) =>
        snapshot.limit > 0 && snapshot.used + (normalized[index]?.amount ?? 0) > snapshot.limit,
    );
    if (denied) {
      return { allowed: false, denied, snapshots };
    }

    const updatedAt = new Date().toISOString();
    for (const [index, reservation] of normalized.entries()) {
      const used = (usages[index] ?? 0) + reservation.amount;
      const data: StoredQuotaUsage = {
        scope: reservation.scope,
        subjectId: reservation.subjectId,
        kind: reservation.kind,
        day: reservation.day,
        used,
        updatedAt,
      };
      await this.scope
        .current()
        .collection(applicationCollectionNames.trialUsage)
        .doc(quotaId(data.scope, data.subjectId, data.kind, data.day))
        .set({ data });
    }
    return {
      allowed: true,
      snapshots: normalized.map((reservation, index) => ({
        scope: reservation.scope,
        subjectId: reservation.subjectId,
        kind: reservation.kind,
        day: reservation.day,
        used: (usages[index] ?? 0) + reservation.amount,
        limit: reservation.limit,
      })),
    };
  }

  async getUsage(
    scope: TrialQuotaScope,
    subjectId: string,
    kind: TrialQuotaKind,
    day: string,
  ): Promise<number> {
    const usage = parseQuotaUsage(
      await this.read(applicationCollectionNames.trialUsage, quotaId(scope, subjectId, kind, day)),
    );
    return usage?.used ?? 0;
  }
}

export function createWechatCloudApplicationPersistence(
  database: WechatCloudDatabase,
): WechatCloudApplicationPersistence {
  const transactions = new WechatCloudTransactionScope(database);
  return {
    transactions,
    analyses: new WechatGarmentAnalysisRepository(transactions),
    assets: new WechatGarmentAssetRepository(transactions),
    tasks: new WechatGenerationTaskRepository(transactions),
    idempotency: new WechatIdempotencyRepository(transactions),
    quotas: new WechatTrialQuotaRepository(transactions),
  };
}
