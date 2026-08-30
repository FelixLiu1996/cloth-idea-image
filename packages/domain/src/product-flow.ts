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

export const garmentRefinementAxisIds = [
  "silhouette-proportion",
  "fabric-paneling",
  "color-finish",
  "decrease-intensity",
  "increase-intensity",
] as const;
export type GarmentRefinementAxisId = (typeof garmentRefinementAxisIds)[number];

export interface GarmentRefinementAxisOption {
  readonly id: GarmentRefinementAxisId;
  readonly kind: "dimension" | "intensity";
  readonly label: string;
  readonly description: string;
  readonly instruction: string;
}

export const garmentRefinementAxisOptions: readonly GarmentRefinementAxisOption[] = [
  {
    id: "silhouette-proportion",
    kind: "dimension",
    label: "廓形与比例",
    description: "只探索松量、肩线和长短比例",
    instruction:
      "本轮只探索廓形与比例：调整松量、肩线或长短比例；保持面料、色彩、领型、门襟、袖口、口袋、辅料、工艺和已锁定元素不变",
  },
  {
    id: "fabric-paneling",
    kind: "dimension",
    label: "面料与拼接",
    description: "只探索材质组合和拼接关系",
    instruction:
      "本轮只探索面料与拼接：调整主辅面料、材质组合或拼接关系；保持品类、整体廓形与比例、领型、门襟、袖型、口袋、色彩基调和已锁定元素不变",
  },
  {
    id: "color-finish",
    kind: "dimension",
    label: "色彩与工艺",
    description: "明确换主色，或只探索洗水、明线和表面工艺",
    instruction:
      "本轮只探索色彩与工艺：若指定目标颜色，必须明显替换服装主体主色而非只改变光影；否则按用户文字调整洗水、明线或表面工艺；保持品类、廓形比例、结构分割、部件位置、面料类型和已锁定元素不变",
  },
  {
    id: "decrease-intensity",
    kind: "intensity",
    label: "改得更保守",
    description: "减少新增结构，优先保留原款识别度",
    instruction:
      "本轮降低改款幅度：减少新增结构和装饰，优先保留原款识别特征，只保留当前方向中最必要的变化；所有已锁定元素必须不变",
  },
  {
    id: "increase-intensity",
    kind: "intensity",
    label: "改得更明显",
    description: "在锁定项范围内强化当前设计方向",
    instruction:
      "本轮提高改款幅度：在不改变品类且不违反已锁定元素的前提下，让当前方向的结构、比例或细节变化更明显；不得无关改色、换面料或改变商品图构图",
  },
];

export function findGarmentRefinementAxisOption(
  axisId: GarmentRefinementAxisId,
): GarmentRefinementAxisOption {
  const option = garmentRefinementAxisOptions.find((candidate) => candidate.id === axisId);
  if (!option) {
    throw new Error(`Unknown garment refinement axis: ${axisId}`);
  }
  return option;
}

export const garmentRefinementColorIds = [
  "red",
  "burgundy",
  "navy",
  "charcoal",
  "olive",
  "coffee",
] as const;
export type GarmentRefinementColorId = (typeof garmentRefinementColorIds)[number];

export interface GarmentRefinementColorOption {
  readonly id: GarmentRefinementColorId;
  readonly label: string;
  readonly hex: `#${string}`;
  readonly aliases: readonly string[];
}

export const garmentRefinementColorOptions: readonly GarmentRefinementColorOption[] = [
  { id: "red", label: "红色", hex: "#B7352F", aliases: ["红色", "正红", "大红"] },
  { id: "burgundy", label: "酒红", hex: "#762F3A", aliases: ["酒红", "酒红色", "勃艮第红"] },
  { id: "navy", label: "深藏蓝", hex: "#26344A", aliases: ["深藏蓝", "藏蓝", "藏青"] },
  { id: "charcoal", label: "炭黑", hex: "#2E2D2B", aliases: ["炭黑", "黑色", "深黑"] },
  { id: "olive", label: "橄榄绿", hex: "#5B6246", aliases: ["橄榄绿", "军绿", "军绿色"] },
  { id: "coffee", label: "咖啡棕", hex: "#654839", aliases: ["咖啡棕", "咖啡色", "棕色"] },
];

export function findGarmentRefinementColorOption(
  colorId: GarmentRefinementColorId,
): GarmentRefinementColorOption {
  const option = garmentRefinementColorOptions.find((candidate) => candidate.id === colorId);
  if (!option) {
    throw new Error(`Unknown garment refinement color: ${colorId}`);
  }
  return option;
}

export interface GarmentRefinementColorTarget {
  readonly label: string;
  readonly hex: `#${string}` | null;
  readonly optionId: GarmentRefinementColorId | null;
}

export function detectGarmentRefinementColorTarget(
  instruction: string,
): GarmentRefinementColorTarget | null {
  const normalized = instruction.trim().replace(/\s+/g, "");
  const replacementTarget = normalized.match(
    /(?:改成|改为|换成|换为|变成|变为|调整为|替换为|使用)([^，。；,.！？!?]{1,18})/,
  )?.[1];
  if (!replacementTarget) {
    return null;
  }
  const knownOption = garmentRefinementColorOptions
    .flatMap((option) => option.aliases.map((alias) => ({ alias, option })))
    .sort((left, right) => right.alias.length - left.alias.length)
    .find(({ alias }) => replacementTarget.includes(alias))?.option;
  if (knownOption) {
    return { label: knownOption.label, hex: knownOption.hex, optionId: knownOption.id };
  }
  const customTarget = replacementTarget.match(
    /^(.{1,8}?(?:色|红|蓝|绿|黑|白|灰|棕|紫|黄|橙|粉|金|银|杏|青))(?:其余|其他|保持|不变|$)/,
  )?.[1];
  if (!customTarget) {
    return null;
  }
  return { label: customTarget, hex: null, optionId: null };
}

export function garmentRefinementNeedsColorTarget(instruction: string): boolean {
  const normalized = instruction.trim().replace(/\s+/g, "");
  if (!/(颜色|色彩|配色|主色|换色)/.test(normalized)) {
    return false;
  }
  if (detectGarmentRefinementColorTarget(normalized)) {
    return false;
  }
  return !/(洗水|做旧|明线|压线|绣花|印花|光泽|哑光|涂层|渐变|拼色|撞色)/.test(normalized);
}

function createGarmentColorReplacementInstruction(target: GarmentRefinementColorTarget): string {
  const colorReference = target.hex ? `（色相参考 ${target.hex}）` : "";
  return `最高优先级强制换色：将服装主体面料的主色明确替换为${target.label}${colorReference}；${target.label}必须覆盖服装主体的大面积区域，不能只出现在纽扣、明线、边饰、阴影或小面积点缀；禁止继续沿用输入原图或较早版本的原主色，也不得仅改变亮度、饱和度、白平衡或背景来冒充换色`;
}

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
  userInstruction = "",
  axisId: GarmentRefinementAxisId | null = null,
  colorId: GarmentRefinementColorId | null = null,
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
  const normalizedUserInstruction = userInstruction.trim().replace(/\s+/g, " ");
  const selectedColor = colorId ? findGarmentRefinementColorOption(colorId) : null;
  const colorTarget: GarmentRefinementColorTarget | null = selectedColor
    ? { label: selectedColor.label, hex: selectedColor.hex, optionId: selectedColor.id }
    : detectGarmentRefinementColorTarget(normalizedUserInstruction);
  const effectiveAxisId = colorTarget ? "color-finish" : axisId;
  const axisInstruction = effectiveAxisId
    ? findGarmentRefinementAxisOption(effectiveAxisId).instruction
    : "";
  const colorInstruction = colorTarget ? createGarmentColorReplacementInstruction(colorTarget) : "";

  if (
    issueInstructions.length === 0 &&
    !normalizedUserInstruction &&
    !axisInstruction &&
    !colorInstruction
  ) {
    return "";
  }

  const unchangedSuffix =
    axisInstruction || colorInstruction
      ? "除选中维度和明确问题外，其余已确认元素和设计方向保持不变。"
      : "其余已确认元素和设计方向保持不变。";
  const clauses = [
    colorInstruction,
    axisInstruction,
    normalizedUserInstruction
      ? `${axisInstruction || colorInstruction ? "在上述范围内执行用户补充要求" : "用户补充要求"}：${normalizedUserInstruction}`
      : "",
    issueInstructions.length > 0 ? `同时修正以下问题：${issueInstructions.join("；")}` : "",
  ].filter(Boolean);
  const body = clauses.join("；");
  const maximumBodyLength = 500 - unchangedSuffix.length - 1;
  return `${body.slice(0, maximumBodyLength)}。${unchangedSuffix}`;
}
