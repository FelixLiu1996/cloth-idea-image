import {
  detectGarmentRefinementColorTarget,
  garmentChangeAreaLabels,
  garmentRefinementAxisOptions,
  type DesignDirection,
  type GenerationApiResponse,
} from "@cloth-idea/domain";

export type ResultPreview = "reference" | "compare" | "current";

export interface ResultComparisonReference {
  readonly kind: "source" | "version";
  readonly label: "原图" | "上一版";
  readonly url: string;
}

export interface ResultChangeItem {
  readonly label: string;
  readonly instruction: string;
}

export interface ResultChangeSummary {
  readonly headline: string;
  readonly context: string;
  readonly items: readonly ResultChangeItem[];
}

export function createResultComparisonReference(
  result: GenerationApiResponse,
  results: readonly GenerationApiResponse[],
  sourceImagePath: string | null,
): ResultComparisonReference | null {
  if (result.parentJobId) {
    const parent = results.find((item) => item.jobId === result.parentJobId);
    if (parent) {
      return { kind: "version", label: "上一版", url: parent.resultUrl };
    }
  }

  return sourceImagePath ? { kind: "source", label: "原图", url: sourceImagePath } : null;
}

export function defaultResultPreview(reference: ResultComparisonReference | null): ResultPreview {
  return reference ? "compare" : "current";
}

interface CreateResultChangeSummaryInput {
  readonly result: GenerationApiResponse;
  readonly direction: DesignDirection | null;
  readonly directChangeRequest: string;
  readonly directStyleDirection: string;
  readonly intensityLabel: string;
  readonly preserveCount: number;
}

function directionItems(direction: DesignDirection | null): readonly ResultChangeItem[] {
  return (
    direction?.changes.map((change) => ({
      label: garmentChangeAreaLabels[change.area],
      instruction: change.instruction,
    })) ?? []
  );
}

function refinementHeadline(instruction: string): string {
  const colorTarget = detectGarmentRefinementColorTarget(instruction);
  if (colorTarget) {
    return `换色目标：${colorTarget.label}`;
  }

  const axis = garmentRefinementAxisOptions.find((option) => {
    const instructionPrefix = option.instruction.split("：")[0];
    return instructionPrefix ? instruction.includes(instructionPrefix) : false;
  });
  if (axis) {
    return `调整重点：${axis.label}`;
  }

  return "按本轮补充要求继续调整";
}

export function createResultChangeSummary(
  input: CreateResultChangeSummaryInput,
): ResultChangeSummary {
  const directionChanges = directionItems(input.direction);
  const directionName = input.result.directionName ?? input.direction?.name;
  const inheritedContext = directionName
    ? `继续沿用「${directionName}」和已确认的锁定内容。`
    : "继续沿用最初改款要求和已确认的锁定内容。";

  if (input.result.operation === "refine") {
    const revisionInstruction = input.result.revisionInstruction ?? "";
    return {
      headline: refinementHeadline(revisionInstruction),
      context: inheritedContext,
      items: revisionInstruction ? [{ label: "本轮追加", instruction: revisionInstruction }] : [],
    };
  }

  const baseItems =
    directionChanges.length > 0
      ? directionChanges
      : [
          { label: "改款要求", instruction: input.directChangeRequest },
          { label: "目标风格", instruction: input.directStyleDirection },
          { label: "改款幅度", instruction: input.intensityLabel },
        ].filter((item) => item.instruction.trim().length > 0);

  if (input.result.operation === "regenerate") {
    return {
      headline: "沿用当前方向，再出一个版本",
      context: "本版没有新增修改指令；设计约束保持一致，图片差异来自重新生成。",
      items: baseItems,
    };
  }

  return {
    headline: directionName ? `设计方向：${directionName}` : "按原始要求生成本版",
    context: `本版使用 ${input.intensityLabel}，并锁定 ${input.preserveCount} 项必须保留内容。`,
    items: baseItems,
  };
}
