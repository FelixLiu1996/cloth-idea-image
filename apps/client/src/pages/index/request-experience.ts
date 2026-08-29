import { GenerationApiError } from "../../services/garment-gateway";

export type ModelRequestKind = "analysis" | "generation" | "refinement";
export type RequestOperation = ModelRequestKind | "save";

export interface RequestProgress {
  readonly kind: ModelRequestKind;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly activeStep: number;
  readonly elapsedSeconds: number;
  readonly progressPercent: number;
  readonly estimate: string;
  readonly navigationHint: string;
}

export type RequestRecovery =
  "retry" | "reselect-source" | "review-access" | "review-input" | "wait" | "limit";

export interface RequestFailure {
  readonly operation: RequestOperation;
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly recovery: RequestRecovery;
  readonly actionLabel: string;
  readonly guidance: string;
}

interface ProgressDefinition {
  readonly title: string;
  readonly description: string;
  readonly expectedSeconds: number;
  readonly steps: readonly string[];
  readonly stepThresholds: readonly [number, number];
}

interface RequestExperienceOptions {
  readonly supportsPendingRestore: boolean;
}

const progressDefinitions: Record<ModelRequestKind, ProgressDefinition> = {
  analysis: {
    title: "正在理解这件原款",
    description: "识别服装结构后，系统会整理出三个可执行的设计方向。",
    expectedSeconds: 50,
    steps: ["读取原款图片", "识别版型与细节", "整理三个设计方向"],
    stepThresholds: [6, 28],
  },
  generation: {
    title: "正在生成新的效果图",
    description: "系统正在按选中方向处理，并会把结果安全转存后再展示。",
    expectedSeconds: 22,
    steps: ["创建改款任务", "生成效果图", "转存并准备展示"],
    stepThresholds: [4, 16],
  },
  refinement: {
    title: "正在生成修改后的下一版",
    description: "系统会从原图重新生成，并同时应用选中方向和累计修改要求。",
    expectedSeconds: 22,
    steps: ["整理修改要求", "重新生成下一版", "转存并准备展示"],
    stepThresholds: [4, 16],
  },
};

const operationTitles: Record<RequestOperation, string> = {
  analysis: "原款分析没有完成",
  generation: "效果图暂未生成",
  refinement: "下一版暂未生成",
  save: "图片尚未保存",
};

function roundEstimate(seconds: number): number {
  return Math.max(5, Math.ceil(seconds / 5) * 5);
}

export function createRequestProgress(
  kind: ModelRequestKind,
  elapsedSecondsInput: number,
  options: RequestExperienceOptions,
): RequestProgress {
  const definition = progressDefinitions[kind];
  const elapsedSeconds = Math.max(0, Math.floor(elapsedSecondsInput));
  const [secondStepAt, thirdStepAt] = definition.stepThresholds;
  const activeStep = elapsedSeconds >= thirdStepAt ? 2 : elapsedSeconds >= secondStepAt ? 1 : 0;
  const remainingSeconds = definition.expectedSeconds - elapsedSeconds;

  return {
    kind,
    title: definition.title,
    description: definition.description,
    steps: definition.steps,
    activeStep,
    elapsedSeconds,
    progressPercent: Math.min(
      92,
      Math.max(8, Math.round((elapsedSeconds / definition.expectedSeconds) * 100)),
    ),
    estimate:
      remainingSeconds > 0
        ? `预计还需约 ${roundEstimate(remainingSeconds)} 秒`
        : `已等待 ${elapsedSeconds} 秒，任务仍在处理中`,
    navigationHint:
      kind === "analysis"
        ? "分析结果尚未持久化，请暂时停留在本页。"
        : options.supportsPendingRestore
          ? "任务创建后可恢复；重新进入小程序会继续查询结果。"
          : "请尽量停留在本页；短暂网络波动不会自动重复创建任务。",
  };
}

function requestError(error: unknown): {
  readonly message: string;
  readonly code: string;
  readonly retryable: boolean;
} {
  if (error instanceof GenerationApiError) {
    return { message: error.message, code: error.code, retryable: error.retryable };
  }
  return {
    message: error instanceof Error ? error.message : "请求失败，请稍后重试。",
    code: "CLIENT_ERROR",
    retryable: true,
  };
}

function isSourceError(code: string): boolean {
  return (
    code === "PARENT_ASSET_EXPIRED" ||
    code === "REFINEMENT_SOURCE_REQUIRED" ||
    code === "EMPTY_IMAGE" ||
    code === "IMAGE_REQUIRED" ||
    code === "IMAGE_TOO_LARGE" ||
    code === "UNSUPPORTED_IMAGE_TYPE" ||
    code === "CLOUD_UPLOAD_FAILED" ||
    code === "VALIDATION_IMAGE_SIZE_REQUIRED" ||
    code === "ANALYSIS_IMAGE_MISMATCH" ||
    code === "REFINEMENT_IMAGE_MISMATCH"
  );
}

function isUncertainTransportError(code: string): boolean {
  return (
    code === "GENERATION_POLL_TIMEOUT" ||
    code === "NETWORK_ERROR" ||
    code === "CLOUD_FUNCTION_UNAVAILABLE"
  );
}

export function createRequestFailure(
  operation: RequestOperation,
  error: unknown,
  options: RequestExperienceOptions,
): RequestFailure {
  const normalized = requestError(error);

  if (isSourceError(normalized.code)) {
    return {
      operation,
      title: operationTitles[operation],
      message: normalized.message,
      code: normalized.code,
      recovery: "reselect-source",
      actionLabel: "重新选择原图",
      guidance:
        operation === "refinement"
          ? "重新选择最初上传的商品图后，可以保留当前版本并继续修改。"
          : "重新选择清晰、受支持且不超过 10 MB 的原图后再试。",
    };
  }

  if (normalized.code.startsWith("AUTH_")) {
    return {
      operation,
      title: "当前账号暂时不能使用",
      message: normalized.message,
      code: normalized.code,
      recovery: "review-access",
      actionLabel: "返回检查试用信息",
      guidance: "请确认当前微信账号已加入体验成员，或检查邀请方提供的访问码。",
    };
  }

  if (
    normalized.code.startsWith("RATE_LIMIT_") ||
    normalized.code === "PROVIDER_RATE_LIMITED" ||
    normalized.code === "REFINEMENT_LIMIT_REACHED"
  ) {
    return {
      operation,
      title: "本次暂时不能继续生成",
      message: normalized.message,
      code: normalized.code,
      recovery: "limit",
      actionLabel: "返回当前页面",
      guidance:
        normalized.code === "REFINEMENT_LIMIT_REACHED"
          ? "当前版本已达到继续修改上限，可以回到原款重新建立一个方向。"
          : "不会自动重复提交；额度或频率恢复后再继续即可。",
    };
  }

  if (
    (operation === "generation" || operation === "refinement") &&
    isUncertainTransportError(normalized.code)
  ) {
    return {
      operation,
      title: "任务状态暂时无法确认",
      message: normalized.message,
      code: normalized.code,
      recovery: "wait",
      actionLabel: "返回当前页面",
      guidance: options.supportsPendingRestore
        ? "请先不要连续提交；如果任务已经创建，重新进入小程序会继续查询结果。"
        : "请先不要连续提交；当前任务可能仍在服务端处理，稍后确认没有结果后再手动生成。",
    };
  }

  if (
    normalized.code === "PROVIDER_REJECTED_INPUT" ||
    normalized.code === "INVALID_GENERATION_REQUEST" ||
    normalized.code.startsWith("VALIDATION_")
  ) {
    return {
      operation,
      title: operationTitles[operation],
      message: normalized.message,
      code: normalized.code,
      recovery: "review-input",
      actionLabel: operation === "refinement" ? "返回修改要求" : "返回检查要求",
      guidance: "检查原图和文字要求后再提交，不会自动调用模型。",
    };
  }

  const canRetry = normalized.retryable || operation === "save";
  return {
    operation,
    title: operationTitles[operation],
    message: normalized.message,
    code: normalized.code,
    recovery: canRetry ? "retry" : "review-input",
    actionLabel:
      operation === "save"
        ? "重新保存"
        : canRetry
          ? operation === "analysis"
            ? "重新分析"
            : "重新提交"
          : operation === "refinement"
            ? "返回修改要求"
            : "返回检查要求",
    guidance: canRetry
      ? operation === "analysis"
        ? "重新分析会使用 1 次分析额度。"
        : operation === "save"
          ? "重新保存不会调用模型，也不会占用生图额度。"
          : "只有你主动重新提交才会再次使用 1 次生图额度。"
      : "请调整输入后再提交；系统不会自动重复调用模型。",
  };
}
