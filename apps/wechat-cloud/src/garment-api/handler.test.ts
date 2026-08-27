import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGarmentCloudHandler,
  type GarmentCloudRepository,
  type StoredInfrastructureProbe,
} from "./handler";

class MemoryRepository implements GarmentCloudRepository {
  readonly probes = new Map<string, StoredInfrastructureProbe>();
  authorized = true;

  isTrialMember(): Promise<boolean> {
    return Promise.resolve(this.authorized);
  }

  findInfrastructureProbe(probeId: string): Promise<StoredInfrastructureProbe | null> {
    return Promise.resolve(this.probes.get(probeId) ?? null);
  }

  saveInfrastructureProbe(probe: StoredInfrastructureProbe): Promise<void> {
    this.probes.set(probe.probeId, probe);
    return Promise.resolve();
  }

  deleteInfrastructureProbe(probeId: string): Promise<void> {
    this.probes.delete(probeId);
    return Promise.resolve();
  }
}

const viewerFingerprint = createHash("sha256").update("openid-user-1").digest("hex").slice(0, 16);

function cloudFileId(fileName = "probe-key-1.jpg"): string {
  return `cloud://env/garment-source-temp/${viewerFingerprint}/incoming/${fileName}`;
}

describe("garment cloud handler", () => {
  let repository: MemoryRepository;
  let handler: ReturnType<typeof createGarmentCloudHandler>;

  beforeEach(() => {
    repository = new MemoryRepository();
    handler = createGarmentCloudHandler({
      getOpenId: () => "openid-user-1",
      repository,
      deleteCloudFile: vi.fn().mockResolvedValue(undefined),
      now: () => "2026-08-27T12:00:00.000Z",
      createRequestId: () => "request-1",
    });
  });

  it("returns a pseudonymous viewer fingerprint without exposing OPENID", async () => {
    const response = await handler({ action: "get-capabilities" });

    expect(response).toMatchObject({
      ok: true,
      data: {
        transport: "wechat-cloud",
        authorized: true,
        viewerFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
    });
    expect(JSON.stringify(response)).not.toContain("openid-user-1");
  });

  it("requires an explicitly authorized trial member for persistent probes", async () => {
    repository.authorized = false;

    await expect(
      handler({
        action: "create-infrastructure-probe",
        idempotencyKey: "probe-key-1",
        cloudFileId: cloudFileId(),
        fileName: "source.jpg",
        mimeType: "image/jpeg",
        size: 100,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_TRIAL_MEMBER_REQUIRED", retryable: false },
    });
  });

  it("persists a probe and returns the same record for an idempotent retry", async () => {
    const request = {
      action: "create-infrastructure-probe" as const,
      idempotencyKey: "probe-key-1",
      cloudFileId: cloudFileId(),
      fileName: "source.jpg",
      mimeType: "image/jpeg" as const,
      size: 100,
    };

    const first = await handler(request);
    const second = await handler(request);

    expect(first).toEqual(second);
    expect(repository.probes).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for a different file", async () => {
    const request = {
      action: "create-infrastructure-probe" as const,
      idempotencyKey: "probe-key-1",
      cloudFileId: cloudFileId(),
      fileName: "source.jpg",
      mimeType: "image/jpeg" as const,
      size: 100,
    };
    await handler(request);

    await expect(handler({ ...request, fileName: "other.jpg" })).resolves.toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_CONFLICT" },
    });
  });

  it("deletes both the owned cloud file and the persisted probe", async () => {
    const deleteCloudFile = vi.fn().mockResolvedValue(undefined);
    handler = createGarmentCloudHandler({
      getOpenId: () => "openid-user-1",
      repository,
      deleteCloudFile,
      now: () => "2026-08-27T12:00:00.000Z",
      createRequestId: () => "request-1",
    });
    const created = await handler({
      action: "create-infrastructure-probe",
      idempotencyKey: "probe-key-1",
      cloudFileId: cloudFileId(),
      fileName: "source.jpg",
      mimeType: "image/jpeg",
      size: 100,
    });
    if (!created.ok || !("probeId" in created.data)) {
      throw new Error("expected probe creation to succeed");
    }

    await expect(
      handler({ action: "delete-infrastructure-probe", probeId: created.data.probeId }),
    ).resolves.toEqual({
      ok: true,
      data: { probeId: created.data.probeId, status: "deleted" },
    });
    expect(deleteCloudFile).toHaveBeenCalledWith(cloudFileId());
    expect(repository.probes).toHaveLength(0);
  });

  it("rejects a cloud file path that is not scoped to the current viewer", async () => {
    await expect(
      handler({
        action: "create-infrastructure-probe",
        idempotencyKey: "probe-key-1",
        cloudFileId: "cloud://env/garment-source-temp/other/incoming/probe-key-1.jpg",
        fileName: "source.jpg",
        mimeType: "image/jpeg",
        size: 100,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION_CLOUD_PROBE_INVALID" },
    });
  });

  it("returns a sanitized retryable error when the repository is unavailable", async () => {
    vi.spyOn(repository, "isTrialMember").mockRejectedValue(new Error("database details"));

    const response = await handler({ action: "get-capabilities" });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "CLOUD_STORAGE_UNAVAILABLE", retryable: true },
    });
    expect(JSON.stringify(response)).not.toContain("database details");
  });
});
