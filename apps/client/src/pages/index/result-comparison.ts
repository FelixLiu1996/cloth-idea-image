import {
  garmentChangeAreaLabels,
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
  readonly title: string;
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

export function createResultChangeSummary(
  input: CreateResultChangeSummaryInput,
): ResultChangeSummary {
  const directionChanges = directionItems(input.direction);
  const directionName = input.result.directionName ?? input.direction?.name;
  const inheritedContext = directionName
    ? `继续继承「${directionName}」的 ${directionChanges.length} 项设计变化和 ${input.preserveCount} 项锁定内容。`
    : `继续继承最初改款要求和 ${input.preserveCount} 项锁定内容。`;

  if (input.result.operation === "refine") {
    return {
      title: "本轮新增修改",
      context: inheritedContext,
      items: input.result.revisionInstruction
        ? [{ label: "本轮追加", instruction: input.result.revisionInstruction }]
        : [],
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
      title: "同方向重新生成",
      context: "本版没有新增修改指令；设计约束保持一致，图片差异来自重新生成。",
      items: baseItems,
    };
  }

  return {
    title: directionName ? `按「${directionName}」生成` : "按原始要求直接生成",
    context: `本版使用 ${input.intensityLabel}，并锁定 ${input.preserveCount} 项必须保留内容。`,
    items: baseItems,
  };
}
