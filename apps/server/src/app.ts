import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import multipart, { type MultipartFile } from "@fastify/multipart";
import {
  buildGarmentPrompt,
  compileAnalyzedGarmentPrompt,
  createGenerationSummary,
  designIntensities,
  findDesignDirection,
  generationModes,
  supportedImageMimeTypes,
  type ApiErrorResponse,
  type GarmentAnalysisBrief,
  type GarmentGenerationInput,
  type GenerationApiResponse,
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
import { GenerationResultRepository } from "./generation-repository";

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

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const assetStore = options.assetStore ?? new LocalAssetStore(options.config.assetDirectory);
  const repository = options.repository ?? new GenerationResultRepository();
  const analysisRepository = options.analysisRepository ?? new GarmentAnalysisRepository();
  const analyzer = options.analyzer ?? new UnconfiguredGarmentAnalysisProvider();

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

    const { analysisId, directionId, ...generationFields } = parsedFields.data;
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

    const execution = await repository.executeOnce(readIdempotencyKey(request), async () => {
      const providerResult = await options.provider.generateVariation({
        sourceImage,
        prompt,
        outputCount: 1,
        promptVersion: input.promptVersion,
      });
      const firstAsset = providerResult.assets[0];
      if (!firstAsset) {
        throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "生图结果中没有图片。");
      }

      const jobId = randomUUID();
      const storedAsset = await assetStore.saveResult(jobId, firstAsset);
      const baseSummary = createGenerationSummary(input);
      const result: GenerationApiResponse = {
        jobId,
        status: "succeeded",
        provider: providerResult.provider,
        model: providerResult.model,
        resultUrl: `${options.config.publicBaseUrl}/api/v1/assets/${jobId}/${storedAsset.fileName}`,
        summary: directionName ? `${baseSummary} · ${directionName}` : baseSummary,
        durationMs: providerResult.durationMs,
        strategy: analyzed ? "analyzed" : "direct",
        directionId: directionId ?? null,
        directionName,
      };

      request.log.info(
        {
          jobId,
          provider: providerResult.provider,
          model: providerResult.model,
          providerRequestId: providerResult.providerRequestId,
          promptVersion: input.promptVersion,
          strategy: result.strategy,
          directionId: result.directionId,
          durationMs: providerResult.durationMs,
          status: result.status,
        },
        "generation completed",
      );
      return result;
    });

    if (execution.reused) {
      request.log.info({ jobId: execution.result.jobId }, "idempotent generation result reused");
    }
    return reply.code(execution.reused ? 200 : 201).send(execution.result);
  });

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
    let statusCode = 500;
    let code = "INTERNAL_ERROR";
    let message = "服务暂时不可用，请稍后重试。";
    let retryable = true;

    if (error instanceof RequestError) {
      statusCode = error.statusCode;
      code = error.code;
      message = error.message;
      retryable = error.retryable;
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

    const response: ApiErrorResponse = {
      code,
      message,
      requestId: request.id,
      retryable,
    };
    request.log.warn({ code, statusCode, retryable }, "API request failed");
    return reply.code(statusCode).send(response);
  });

  return app;
}
