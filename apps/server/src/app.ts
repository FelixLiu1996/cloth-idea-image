import { createHash, randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import multipart, { type MultipartFile } from "@fastify/multipart";
import {
  buildGarmentPrompt,
  compileAnalyzedGarmentPrompt,
  compileGarmentIterationPrompt,
  createGenerationSummary,
  designIntensities,
  findDesignDirection,
  generationModes,
  supportedImageMimeTypes,
  type ApiErrorResponse,
  type GarmentAnalysisBrief,
  type GarmentGenerationInput,
  type GenerationApiResponse,
  type GenerationJobStatusResponse,
  type GenerationOperation,
  type GenerationPromptVersion,
  type SourceImageInput,
  type SupportedImageMimeType,
} from "@cloth-idea/domain";
import {
  GarmentProviderError,
  type GarmentAnalysisProvider,
  type GarmentImageProvider,
  type ProviderErrorCode,
  UnconfiguredGarmentAnalysisProvider,
} from "@cloth-idea/model-providers";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import { LocalAssetStore } from "./asset-store";
import type { ServerConfig } from "./config";
import { GarmentAnalysisRepository } from "./garment-analysis-repository";
import {
  GenerationResultRepository,
  IdempotencyKeyConflictError,
  type StoredGenerationRecord,
} from "./generation-repository";

const generationFieldsSchema = z.object({
  mode: z.enum(generationModes),
  preserveItems: z
    .string()
    .max(500)
    .transform((value) =>
      value
        .split(/[，,、\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  changeRequest: z.string().trim().min(2, "请填写改款要求。").max(1_000),
  styleDirection: z.string().trim().min(2, "请填写目标风格。").max(500),
  intensity: z.enum(designIntensities),
});

const createGenerationFieldsSchema = generationFieldsSchema
  .extend({
    analysisId: z.string().uuid().optional(),
    directionId: z
      .string()
      .regex(/^direction-[1-3]$/)
      .optional(),
    parentJobId: z.string().uuid().optional(),
  })
  .superRefine((fields, context) => {
    if ((fields.analysisId === undefined) !== (fields.directionId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["analysisId"],
        message: "analysisId 和 directionId 必须同时提供。",
      });
    }
  });

const refinementFieldsSchema = z.object({
  instruction: z.string().trim().min(2, "请填写需要继续修改的内容。").max(500),
});
const maxRefinementDepth = 5;

interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly provider: GarmentImageProvider;
  readonly analyzer?: GarmentAnalysisProvider;
  readonly assetStore?: LocalAssetStore;
  readonly repository?: GenerationResultRepository;
  readonly analysisRepository?: GarmentAnalysisRepository;
  readonly logger?: boolean;
}

class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | null {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function hasErrorCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

function providerStatus(code: ProviderErrorCode): number {
  switch (code) {
    case "PROVIDER_REJECTED_INPUT":
      return 422;
    case "PROVIDER_RATE_LIMITED":
      return 429;
    case "PROVIDER_TIMEOUT":
      return 504;
    case "PROVIDER_AUTH_FAILED":
    case "PROVIDER_BAD_RESPONSE":
      return 502;
    case "PROVIDER_NOT_CONFIGURED":
    case "PROVIDER_UNAVAILABLE":
      return 503;
  }
}

interface NormalizedError {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly providerValidationIssues:
    readonly { readonly code: string; readonly path: string }[] | undefined;
}

function normalizeError(error: unknown): NormalizedError {
  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "服务暂时不可用，请稍后重试。";
  let retryable = true;

  if (error instanceof RequestError) {
    statusCode = error.statusCode;
    code = error.code;
    message = error.message;
    retryable = error.retryable;
  } else if (error instanceof IdempotencyKeyConflictError) {
    statusCode = 409;
    code = "IDEMPOTENCY_KEY_REUSED";
    message = error.message;
    retryable = false;
  } else if (error instanceof GarmentProviderError) {
    statusCode = providerStatus(error.code);
    code = error.code;
    message = error.message;
    retryable = error.retryable;
  } else if (hasErrorCode(error) && error.code === "FST_REQ_FILE_TOO_LARGE") {
    statusCode = 413;
    code = "IMAGE_TOO_LARGE";
    message = "图片不能超过 10 MB。";
    retryable = false;
  }

  const providerValidationIssues =
    error instanceof GarmentProviderError && error.cause instanceof z.ZodError
      ? error.cause.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
        }))
      : undefined;

  return { statusCode, code, message, retryable, providerValidationIssues };
}

async function fileToSourceImage(file: MultipartFile): Promise<SourceImageInput> {
  const bytes = await file.toBuffer();
  if (bytes.length === 0) {
    throw new RequestError(400, "EMPTY_IMAGE", "上传的图片为空。");
  }
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new RequestError(415, "UNSUPPORTED_IMAGE_TYPE", "图片仅支持 JPG、PNG 或 WEBP。");
  }

  return {
    bytes,
    fileName: file.filename,
    mimeType,
  };
}

async function readMultipartRequest(request: FastifyRequest): Promise<{
  readonly fields: Record<string, string>;
  readonly sourceImage: SourceImageInput;
}> {
  const fields: Record<string, string> = {};
  let sourceImage: SourceImageInput | undefined;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "sourceImage") {
        part.file.resume();
        continue;
      }
      sourceImage = await fileToSourceImage(part);
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }

  if (!sourceImage) {
    throw new RequestError(400, "IMAGE_REQUIRED", "请选择一张服装图片。");
  }
  return { fields, sourceImage };
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return Array.isArray(header) ? header[0] : header;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createRequestFingerprint(value: object): string {
  return sha256(JSON.stringify(value));
}

interface RunGenerationOptions {
  readonly sourceImage: SourceImageInput;
  readonly prompt: string;
  readonly promptVersion: GenerationPromptVersion;
  readonly summary: string;
  readonly basePrompt: string;
  readonly baseSummary: string;
  readonly baseRequestFingerprint: string;
  readonly sourceImageSha256: string;
  readonly revisionInstructions: readonly string[];
  readonly strategy: GenerationApiResponse["strategy"];
  readonly directionId: string | null;
  readonly directionName: string | null;
  readonly operation: GenerationOperation;
  readonly parentJobId: string | null;
  readonly revisionInstruction: string | null;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const assetStore = options.assetStore ?? new LocalAssetStore(options.config.assetDirectory);
  const repository = options.repository ?? new GenerationResultRepository();
  const analysisRepository = options.analysisRepository ?? new GarmentAnalysisRepository();
  const analyzer = options.analyzer ?? new UnconfiguredGarmentAnalysisProvider();

  async function runGeneration(
    request: FastifyRequest,
    jobId: string,
    createdAt: string,
    input: RunGenerationOptions,
  ): Promise<StoredGenerationRecord> {
    const providerResult = await options.provider.generateVariation({
      sourceImage: input.sourceImage,
      prompt: input.prompt,
      outputCount: 1,
      promptVersion: input.promptVersion,
    });
    const firstAsset = providerResult.assets[0];
    if (!firstAsset) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "生图结果中没有图片。");
    }

    const storedAsset = await assetStore.saveResult(jobId, firstAsset);
    const result: GenerationApiResponse = {
      jobId,
      status: "succeeded",
      provider: providerResult.provider,
      model: providerResult.model,
      resultUrl: `${options.config.publicBaseUrl}/api/v1/assets/${jobId}/${storedAsset.fileName}`,
      summary: input.summary,
      durationMs: providerResult.durationMs,
      strategy: input.strategy,
      directionId: input.directionId,
      directionName: input.directionName,
      operation: input.operation,
      parentJobId: input.parentJobId,
      revisionInstruction: input.revisionInstruction,
      createdAt,
    };

    const record: StoredGenerationRecord = {
      response: result,
      assetFileName: storedAsset.fileName,
      assetMimeType: storedAsset.mimeType,
      basePrompt: input.basePrompt,
      baseSummary: input.baseSummary,
      baseRequestFingerprint: input.baseRequestFingerprint,
      sourceImageSha256: input.sourceImageSha256,
      revisionInstructions: input.revisionInstructions,
    };

    request.log.info(
      {
        jobId,
        parentJobId: input.parentJobId,
        operation: input.operation,
        sourceStrategy: input.operation === "refine" ? "original-image-rebuild" : "uploaded-image",
        provider: providerResult.provider,
        model: providerResult.model,
        providerRequestId: providerResult.providerRequestId,
        promptVersion: input.promptVersion,
        strategy: result.strategy,
        directionId: result.directionId,
        durationMs: providerResult.durationMs,
        usage: providerResult.usage,
        status: result.status,
      },
      "generation completed",
    );
    return record;
  }

  function enqueueGeneration(
    request: FastifyRequest,
    requestFingerprint: string,
    input: RunGenerationOptions,
  ): { readonly job: GenerationJobStatusResponse; readonly reused: boolean } {
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const execution = repository.enqueueOnce({
      jobId,
      statusUrl: `${options.config.publicBaseUrl}/api/v1/generations/${jobId}`,
      createdAt,
      idempotencyKey: readIdempotencyKey(request),
      requestFingerprint,
      operation: () => runGeneration(request, jobId, createdAt, input),
      mapError: (error) => {
        const normalized = normalizeError(error);
        request.log.warn(
          {
            jobId,
            code: normalized.code,
            retryable: normalized.retryable,
            providerValidationIssues: normalized.providerValidationIssues,
          },
          "generation job failed",
        );
        return {
          code: normalized.code,
          message: normalized.message,
          requestId: request.id,
          retryable: normalized.retryable,
        };
      },
    });

    if (execution.reused) {
      request.log.info({ jobId: execution.job.jobId }, "idempotent generation job reused");
    } else {
      request.log.info({ jobId, status: "queued" }, "generation job queued");
    }
    return execution;
  }

  await app.register(cors, {
    origin: options.config.clientOrigin === "*" ? true : options.config.clientOrigin,
  });
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: options.config.maxUploadBytes,
      fields: 10,
      parts: 11,
    },
  });

  app.get("/health", async () => ({
    status: "ok",
    provider: options.provider.provider,
    model: options.provider.model,
    providerConfigured: options.provider.configured,
    analysisProvider: analyzer.provider,
    analysisModel: analyzer.model,
    analysisProviderConfigured: analyzer.configured,
  }));

  app.get("/api/v1/capabilities", async () => ({
    modes: generationModes,
    intensities: designIntensities,
    supportedImageMimeTypes,
    maxUploadBytes: options.config.maxUploadBytes,
    outputCount: 1,
    analysisEnabled: analyzer.configured,
    analysisSchemaVersion: "garment-dna-v0.2",
    resultIterationEnabled: true,
    generationJobsAsync: true,
    maxRefinementDepth,
  }));

  app.post("/api/v1/analyses", async (request, reply) => {
    const { fields, sourceImage } = await readMultipartRequest(request);
    const parsedFields = generationFieldsSchema.safeParse(fields);
    if (!parsedFields.success) {
      throw new RequestError(
        400,
        "INVALID_ANALYSIS_REQUEST",
        parsedFields.error.issues[0]?.message ?? "分析参数不完整。",
      );
    }

    const brief: GarmentAnalysisBrief = parsedFields.data;
    const execution = await analysisRepository.executeOnce(
      readIdempotencyKey(request),
      async () => {
        const providerResult = await analyzer.analyze({
          sourceImage,
          brief,
          schemaVersion: "garment-dna-v0.2",
        });
        const result = analysisRepository.save(sourceImage, providerResult);
        request.log.info(
          {
            analysisId: result.analysisId,
            provider: providerResult.provider,
            model: providerResult.model,
            providerRequestId: providerResult.providerRequestId,
            schemaVersion: providerResult.analysis.schemaVersion,
            durationMs: providerResult.durationMs,
            attemptCount: providerResult.attemptCount,
            usage: providerResult.usage,
          },
          "garment analysis completed",
        );
        return result;
      },
    );

    return reply.code(execution.reused ? 200 : 201).send(execution.result);
  });

  app.post("/api/v1/generations", async (request, reply) => {
    const { fields, sourceImage } = await readMultipartRequest(request);
    const parsedFields = createGenerationFieldsSchema.safeParse(fields);
    if (!parsedFields.success) {
      throw new RequestError(
        400,
        "INVALID_GENERATION_REQUEST",
        parsedFields.error.issues[0]?.message ?? "改款参数不完整。",
      );
    }

    const { analysisId, directionId, parentJobId, ...generationFields } = parsedFields.data;
    const analyzed = analysisId !== undefined && directionId !== undefined;
    const input: GarmentGenerationInput = {
      ...generationFields,
      sourceImage,
      outputCount: 1,
      promptVersion: analyzed ? "garment-analysis-v1" : "garment-redesign-v1",
    };

    let prompt: string;
    let directionName: string | null = null;
    if (analyzed) {
      const storedAnalysis = analysisRepository.get(analysisId);
      if (!storedAnalysis) {
        throw new RequestError(404, "ANALYSIS_NOT_FOUND", "服装分析不存在或已过期，请重新分析。");
      }
      if (!analysisRepository.matchesSourceImage(analysisId, sourceImage)) {
        throw new RequestError(
          409,
          "ANALYSIS_IMAGE_MISMATCH",
          "当前图片与服装分析不一致，请重新分析。",
        );
      }
      const direction = findDesignDirection(storedAnalysis.analysis, directionId);
      if (!direction) {
        throw new RequestError(404, "DIRECTION_NOT_FOUND", "选择的设计方向不存在。");
      }
      directionName = direction.name;
      prompt = compileAnalyzedGarmentPrompt({
        request: input,
        analysis: storedAnalysis.analysis,
        direction,
      });
    } else {
      prompt = buildGarmentPrompt(input);
    }

    const baseSummary = createGenerationSummary(input);
    const resultSummary = directionName ? `${baseSummary} · ${directionName}` : baseSummary;
    const baseRequestFingerprint = createRequestFingerprint({
      type: "generation-base",
      sourceImageSha256: sha256(sourceImage.bytes),
      generationFields,
      analysisId: analysisId ?? null,
      directionId: directionId ?? null,
    });
    let operation: GenerationOperation = "initial";
    if (parentJobId) {
      const parent = repository.get(parentJobId);
      if (!parent) {
        throw new RequestError(404, "PARENT_GENERATION_NOT_FOUND", "上一张生成结果不存在。");
      }
      if (parent.baseRequestFingerprint !== baseRequestFingerprint) {
        throw new RequestError(
          409,
          "PARENT_GENERATION_MISMATCH",
          "上一张结果与当前原图或设计方向不一致，无法作为重新生成的父任务。",
        );
      }
      operation = "regenerate";
    }

    const execution = enqueueGeneration(
      request,
      createRequestFingerprint({
        type: "generation",
        baseRequestFingerprint,
        parentJobId: parentJobId ?? null,
      }),
      {
        sourceImage,
        prompt,
        promptVersion: input.promptVersion,
        summary: resultSummary,
        basePrompt: prompt,
        baseSummary: resultSummary,
        baseRequestFingerprint,
        sourceImageSha256: sha256(sourceImage.bytes),
        revisionInstructions: [],
        strategy: analyzed ? "analyzed" : "direct",
        directionId: directionId ?? null,
        directionName,
        operation,
        parentJobId: parentJobId ?? null,
        revisionInstruction: null,
      },
    );

    return reply.code(execution.reused ? 200 : 202).send(execution.job);
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generations/:jobId", async (request, reply) => {
    const job = repository.getJob(request.params.jobId);
    if (!job) {
      throw new RequestError(404, "GENERATION_JOB_NOT_FOUND", "生成任务不存在或已经过期。");
    }
    return reply.header("Cache-Control", "no-store").send(job);
  });

  app.post<{ Params: { jobId: string } }>(
    "/api/v1/generations/:jobId/refinements",
    async (request, reply) => {
      const { fields, sourceImage } = await readMultipartRequest(request);
      const parsedBody = refinementFieldsSchema.safeParse(fields);
      if (!parsedBody.success) {
        throw new RequestError(
          400,
          "INVALID_REFINEMENT_REQUEST",
          parsedBody.error.issues[0]?.message ?? "继续修改参数不完整。",
        );
      }

      const parent = repository.get(request.params.jobId);
      if (!parent) {
        throw new RequestError(404, "PARENT_GENERATION_NOT_FOUND", "上一张生成结果不存在。");
      }
      if (parent.revisionInstructions.length >= maxRefinementDepth) {
        throw new RequestError(
          409,
          "REFINEMENT_LIMIT_REACHED",
          `当前分支最多连续修改 ${maxRefinementDepth} 次，请从原图或其他方向重新生成。`,
        );
      }
      const parentAsset = await assetStore.readResult(parent.response.jobId, parent.assetFileName);
      if (!parentAsset) {
        throw new RequestError(410, "PARENT_ASSET_EXPIRED", "上一张结果图片已过期，无法继续修改。");
      }
      const sourceImageFingerprint = sha256(sourceImage.bytes);
      if (sourceImageFingerprint !== parent.sourceImageSha256) {
        throw new RequestError(
          409,
          "REFINEMENT_IMAGE_MISMATCH",
          "当前原图与生成分支不一致，无法继续修改。",
        );
      }

      const revisionInstructions = [...parent.revisionInstructions, parsedBody.data.instruction];
      const prompt = compileGarmentIterationPrompt({
        basePrompt: parent.basePrompt,
        revisionInstructions,
        usesOriginalSourceImage: true,
      });
      const requestFingerprint = createRequestFingerprint({
        type: "refinement",
        parentJobId: parent.response.jobId,
        instruction: parsedBody.data.instruction,
        sourceImageSha256: sourceImageFingerprint,
      });
      const execution = enqueueGeneration(request, requestFingerprint, {
        sourceImage,
        prompt,
        promptVersion: "garment-iteration-v1",
        summary: `${parent.baseSummary} · 继续修改：${parsedBody.data.instruction}`,
        basePrompt: parent.basePrompt,
        baseSummary: parent.baseSummary,
        baseRequestFingerprint: parent.baseRequestFingerprint,
        sourceImageSha256: parent.sourceImageSha256,
        revisionInstructions,
        strategy: parent.response.strategy,
        directionId: parent.response.directionId,
        directionName: parent.response.directionName,
        operation: "refine",
        parentJobId: parent.response.jobId,
        revisionInstruction: parsedBody.data.instruction,
      });

      return reply.code(execution.reused ? 200 : 202).send(execution.job);
    },
  );

  app.get<{ Params: { jobId: string; fileName: string } }>(
    "/api/v1/assets/:jobId/:fileName",
    async (request, reply) => {
      const asset = await assetStore.readResult(request.params.jobId, request.params.fileName);
      if (!asset) {
        throw new RequestError(404, "ASSET_NOT_FOUND", "结果图片不存在或已过期。");
      }

      return reply
        .header("Cache-Control", "private, max-age=86400")
        .type(asset.mimeType)
        .send(asset.bytes);
    },
  );

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);

    const response: ApiErrorResponse = {
      code: normalized.code,
      message: normalized.message,
      requestId: request.id,
      retryable: normalized.retryable,
    };
    request.log.warn(
      {
        code: normalized.code,
        statusCode: normalized.statusCode,
        retryable: normalized.retryable,
        providerValidationIssues: normalized.providerValidationIssues,
      },
      "API request failed",
    );
    return reply.code(normalized.statusCode).send(response);
  });

  return app;
}
