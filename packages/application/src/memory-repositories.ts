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
} from "./ports";

interface MemoryTransactionParticipant {
  createSnapshot(): unknown;
  restoreSnapshot(snapshot: unknown): void;
}

function recordKey(ownerId: string, resourceId: string): string {
  return `${ownerId}\u0000${resourceId}`;
}

function idempotencyKey(ownerId: string, action: IdempotencyAction, key: string): string {
  return `${ownerId}\u0000${action}\u0000${key}`;
}

function quotaKey(
  scope: TrialQuotaScope,
  subjectId: string,
  kind: TrialQuotaKind,
  day: string,
): string {
  return `${scope}\u0000${subjectId}\u0000${kind}\u0000${day}`;
}

function isExpired(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

function assertIsoDate(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("时间必须使用有效的 ISO 8601 字符串。");
  }
}

export class MemoryGarmentAnalysisRepository
  implements GarmentAnalysisRepository, MemoryTransactionParticipant
{
  private records = new Map<string, GarmentAnalysisRecord>();

  async findById(
    ownerId: string,
    analysisId: string,
    now: string,
  ): Promise<GarmentAnalysisRecord | null> {
    assertIsoDate(now);
    const key = recordKey(ownerId, analysisId);
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (isExpired(record.expiresAt, now)) {
      this.records.delete(key);
      return null;
    }
    return record;
  }

  async save(record: GarmentAnalysisRecord): Promise<void> {
    assertIsoDate(record.expiresAt);
    this.records.set(recordKey(record.ownerId, record.analysisId), record);
  }

  async deleteExpired(now: string): Promise<number> {
    assertIsoDate(now);
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (isExpired(record.expiresAt, now)) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  createSnapshot(): unknown {
    return new Map(this.records);
  }

  restoreSnapshot(snapshot: unknown): void {
    this.records = new Map(snapshot as Map<string, GarmentAnalysisRecord>);
  }
}

export class MemoryGenerationTaskRepository
  implements GenerationTaskRepository, MemoryTransactionParticipant
{
  private records = new Map<string, GenerationTaskRecord>();

  async findById(
    ownerId: string,
    jobId: string,
    now: string,
  ): Promise<GenerationTaskRecord | null> {
    assertIsoDate(now);
    const key = recordKey(ownerId, jobId);
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (isExpired(record.expiresAt, now)) {
      this.records.delete(key);
      return null;
    }
    return record;
  }

  async create(record: GenerationTaskRecord): Promise<boolean> {
    assertIsoDate(record.expiresAt);
    const key = recordKey(record.ownerId, record.jobId);
    if (this.records.has(key)) {
      return false;
    }
    this.records.set(key, record);
    return true;
  }

  async update(record: GenerationTaskRecord): Promise<boolean> {
    const key = recordKey(record.ownerId, record.jobId);
    if (!this.records.has(key)) {
      return false;
    }
    this.records.set(key, record);
    return true;
  }

  async deleteExpired(now: string): Promise<number> {
    assertIsoDate(now);
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (isExpired(record.expiresAt, now)) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  createSnapshot(): unknown {
    return new Map(this.records);
  }

  restoreSnapshot(snapshot: unknown): void {
    this.records = new Map(snapshot as Map<string, GenerationTaskRecord>);
  }
}

export class MemoryIdempotencyRepository
  implements IdempotencyRepository, MemoryTransactionParticipant
{
  private records = new Map<string, IdempotencyRecord>();

  async find(
    ownerId: string,
    action: IdempotencyAction,
    key: string,
    now: string,
  ): Promise<IdempotencyRecord | null> {
    assertIsoDate(now);
    const storageKey = idempotencyKey(ownerId, action, key);
    const record = this.records.get(storageKey);
    if (!record) {
      return null;
    }
    if (isExpired(record.expiresAt, now)) {
      this.records.delete(storageKey);
      return null;
    }
    return record;
  }

  async create(record: IdempotencyRecord): Promise<boolean> {
    assertIsoDate(record.expiresAt);
    const key = idempotencyKey(record.ownerId, record.action, record.key);
    if (this.records.has(key)) {
      return false;
    }
    this.records.set(key, record);
    return true;
  }

  async deleteExpired(now: string): Promise<number> {
    assertIsoDate(now);
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (isExpired(record.expiresAt, now)) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  createSnapshot(): unknown {
    return new Map(this.records);
  }

  restoreSnapshot(snapshot: unknown): void {
    this.records = new Map(snapshot as Map<string, IdempotencyRecord>);
  }
}

export class MemoryTrialQuotaRepository
  implements TrialQuotaRepository, MemoryTransactionParticipant
{
  private usage = new Map<string, number>();

  async reserveMany(
    reservations: readonly TrialQuotaReservation[],
  ): Promise<TrialQuotaReservationResult> {
    const combined = new Map<string, TrialQuotaReservation>();
    for (const reservation of reservations) {
      this.assertReservation(reservation);
      const key = quotaKey(
        reservation.scope,
        reservation.subjectId,
        reservation.kind,
        reservation.day,
      );
      const existing = combined.get(key);
      if (existing && existing.limit !== reservation.limit) {
        throw new Error("同一额度维度不能使用不同的上限。");
      }
      combined.set(key, {
        ...reservation,
        amount: (existing?.amount ?? 0) + reservation.amount,
      });
    }

    const normalizedReservations = [...combined.values()];
    const snapshots = normalizedReservations.map((reservation) => this.snapshotFor(reservation));
    const denied = snapshots.find(
      (snapshot, index) =>
        snapshot.limit > 0 &&
        snapshot.used + (normalizedReservations[index]?.amount ?? 0) > snapshot.limit,
    );
    if (denied) {
      return { allowed: false, denied, snapshots };
    }

    for (const reservation of normalizedReservations) {
      const key = quotaKey(
        reservation.scope,
        reservation.subjectId,
        reservation.kind,
        reservation.day,
      );
      this.usage.set(key, (this.usage.get(key) ?? 0) + reservation.amount);
    }
    return {
      allowed: true,
      snapshots: normalizedReservations.map((reservation) => this.snapshotFor(reservation)),
    };
  }

  async getUsage(
    scope: TrialQuotaScope,
    subjectId: string,
    kind: TrialQuotaKind,
    day: string,
  ): Promise<number> {
    return this.usage.get(quotaKey(scope, subjectId, kind, day)) ?? 0;
  }

  createSnapshot(): unknown {
    return new Map(this.usage);
  }

  restoreSnapshot(snapshot: unknown): void {
    this.usage = new Map(snapshot as Map<string, number>);
  }

  private snapshotFor(reservation: TrialQuotaReservation): TrialQuotaSnapshot {
    this.assertReservation(reservation);
    return {
      scope: reservation.scope,
      subjectId: reservation.subjectId,
      kind: reservation.kind,
      day: reservation.day,
      used:
        this.usage.get(
          quotaKey(reservation.scope, reservation.subjectId, reservation.kind, reservation.day),
        ) ?? 0,
      limit: reservation.limit,
    };
  }

  private assertReservation(reservation: TrialQuotaReservation): void {
    if (!Number.isInteger(reservation.amount) || reservation.amount <= 0) {
      throw new Error("额度预占数量必须是正整数。");
    }
    if (!Number.isInteger(reservation.limit) || reservation.limit < 0) {
      throw new Error("额度上限必须是非负整数。");
    }
  }
}

export class MemoryGarmentAssetRepository
  implements GarmentAssetRepository, MemoryTransactionParticipant
{
  private records = new Map<string, GarmentAssetRecord>();

  async findById(
    ownerId: string,
    assetId: string,
    now: string,
  ): Promise<GarmentAssetRecord | null> {
    assertIsoDate(now);
    const key = recordKey(ownerId, assetId);
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (isExpired(record.expiresAt, now)) {
      this.records.delete(key);
      return null;
    }
    return record;
  }

  async save(record: GarmentAssetRecord): Promise<void> {
    assertIsoDate(record.expiresAt);
    this.records.set(recordKey(record.ownerId, record.assetId), record);
  }

  async findExpired(now: string, limit: number): Promise<readonly GarmentAssetRecord[]> {
    assertIsoDate(now);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("过期资产查询数量必须是正整数。");
    }
    return [...this.records.values()]
      .filter((record) => isExpired(record.expiresAt, now))
      .slice(0, limit);
  }

  async hasActiveFileReference(fileId: string, now: string): Promise<boolean> {
    assertIsoDate(now);
    return [...this.records.values()].some(
      (record) => record.fileId === fileId && !isExpired(record.expiresAt, now),
    );
  }

  async delete(ownerId: string, assetId: string): Promise<boolean> {
    return this.records.delete(recordKey(ownerId, assetId));
  }

  createSnapshot(): unknown {
    return new Map(this.records);
  }

  restoreSnapshot(snapshot: unknown): void {
    this.records = new Map(snapshot as Map<string, GarmentAssetRecord>);
  }
}

export class MemoryTransactionRunner implements ApplicationTransactionRunner {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly participants: readonly MemoryTransactionParticipant[]) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.pending;
    this.pending = previous.then(() => turn);
    await previous;

    const snapshots = this.participants.map((participant) => participant.createSnapshot());
    try {
      return await operation();
    } catch (error) {
      this.participants.forEach((participant, index) => {
        participant.restoreSnapshot(snapshots[index]);
      });
      throw error;
    } finally {
      release?.();
    }
  }
}
