import {
  applyEvidenceGate,
  garmentFactKeys,
  type DesignDirection,
  type GarmentAnalysis,
  type GarmentChangeArea,
  type GarmentFactKey,
} from "./garment-analysis";

export const maximumConfirmedPreserveItems = 16;
export const maximumPreserveItemsTextLength = 500;

export const garmentFactLabels: Record<GarmentFactKey, string> = {
  category: "品类",
  silhouette: "廓形",
  length: "衣长",
  shoulder: "肩型",
  collar: "领型",
  closure: "门襟",
  sleeve: "袖型",
  cuff: "袖口",
  pockets: "口袋",
  frontPanels: "前片结构",
  backPanels: "后片结构",
  fabric: "面料",
  color: "色彩",
  trims: "辅料",
  craftsmanship: "工艺",
  presentation: "商品图构图",
};

export const garmentChangeAreaLabels: Record<GarmentChangeArea, string> = {
  silhouette: "廓形",
  proportion: "比例",
  shoulder: "肩型",
  collar: "领型",
  closure: "门襟",
  sleeve: "袖型",
  cuff: "袖口",
  pockets: "口袋",
  panels: "结构分割",
  fabric: "面料",
  color: "色彩",
  trims: "辅料",
  craftsmanship: "工艺",
  presentation: "商品图构图",
};

const preservableFactKeys = new Set<GarmentFactKey>(
  garmentFactKeys.filter((key) => key !== "presentation"),
);

function factValue(value: string | string[] | null): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => item.trim())
      .filter(Boolean)
      .join("、");
  }
  return value?.trim() ?? "";
}

export function mergePreserveItems(...groups: readonly (readonly string[])[]): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const item of groups.flat()) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
    if (merged.length >= maximumConfirmedPreserveItems) {
      break;
    }
  }
  return merged;
}

export function parsePreserveItems(value: string): readonly string[] {
  return mergePreserveItems(
    value
      .split(/[，,、\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function serializePreserveItems(items: readonly string[]): string {
  return mergePreserveItems(items).join("，");
}

export function formatGarmentPreserveItem(item: string): string {
  const normalized = item.trim();
  const matchingKey = garmentFactKeys.find((key) => key === normalized);
  return matchingKey ? garmentFactLabels[matchingKey] : normalized;
}

export interface PreserveItemSuggestion {
  readonly id: `fact:${GarmentFactKey}`;
  readonly factKey: GarmentFactKey;
  readonly label: string;
  readonly value: string;
  readonly preserveItem: string;
  readonly confidence: number;
  readonly evidence: string;
}

export function createPreserveItemSuggestions(
  analysis: GarmentAnalysis,
): readonly PreserveItemSuggestion[] {
  return applyEvidenceGate(analysis.visualFacts).accepted.flatMap(({ key, fact }) => {
    const value = factValue(fact.value);
    if (!preservableFactKeys.has(key) || !value) {
      return [];
    }
    const label = garmentFactLabels[key];
    return [
      {
        id: `fact:${key}` as const,
        factKey: key,
        label,
        value,
        preserveItem: `${label}：${value}`,
        confidence: fact.confidence,
        evidence: fact.evidence,
      },
    ];
  });
}

export const garmentResultReviewStatuses = ["pending", "pass", "question", "fail"] as const;
export type GarmentResultReviewStatus = (typeof garmentResultReviewStatuses)[number];

export const garmentResultReviewKinds = ["preservation", "change", "anomaly"] as const;
export type GarmentResultReviewKind = (typeof garmentResultReviewKinds)[number];

export interface GarmentResultReviewItem {
  readonly id: string;
  readonly kind: GarmentResultReviewKind;
  readonly title: string;
  readonly instruction: string;
}

export interface CreateGarmentResultReviewPlanInput {
  readonly preserveItems: readonly string[];
  readonly direction?: DesignDirection | null;
}

export function createGarmentResultReviewPlan(
  input: CreateGarmentResultReviewPlanInput,
): readonly GarmentResultReviewItem[] {
  const direction = input.direction ?? null;
  const preserveItems = mergePreserveItems(input.preserveItems, direction?.preserve ?? []).map(
    formatGarmentPreserveItem,
  );
  const preservationItems = preserveItems.map((item, index) => ({
    id: `preservation-${index + 1}`,
    kind: "preservation" as const,
    title: item,
    instruction: "对照原图确认这一锁定元素仍然清晰、位置合理且没有被替换。",
  }));
  const changeItems = (direction?.changes ?? []).map((change, index) => ({
    id: `change-${index + 1}`,
    kind: "change" as const,
    title: `${garmentChangeAreaLabels[change.area]}：${change.instruction}`,
    instruction: "确认指定变化已经落实，并且没有破坏其他未要求修改的区域。",
  }));

  return [
    ...preservationItems,
    ...changeItems,
    {
      id: "anomaly-unrequested-change",
      kind: "anomaly",
      title: "未要求的明显变化",
      instruction: "对比原图，确认品类、主体构图和未指定区域没有无故漂移。",
    },
    {
      id: "anomaly-text-watermark",
      kind: "anomaly",
      title: "文字与水印",
      instruction: "确认没有复现型号、货号、价格、联系方式、品牌文字或新增水印。",
    },
    {
      id: "anomaly-structure-quality",
      kind: "anomaly",
      title: "结构与图像质量",
      instruction: "确认没有重复部件、悬空结构、明显噪点、锐化、偏色或不合理缝制。",
    },
  ];
}

export function createGarmentRefinementInstruction(
  reviewItems: readonly GarmentResultReviewItem[],
): string {
  const issueInstructions = reviewItems.map((item) => {
    if (item.kind === "preservation") {
      return `恢复并清晰保留“${item.title}”`;
    }
    if (item.kind === "change") {
      return `完整落实“${item.title}”`;
    }
    return `修正“${item.title}”`;
  });

  if (issueInstructions.length === 0) {
    return "";
  }

  return `请修正以下问题：${issueInstructions.join("；")}。其余已确认元素和设计方向保持不变。`.slice(
    0,
    500,
  );
}
