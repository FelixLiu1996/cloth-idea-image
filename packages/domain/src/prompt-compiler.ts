import type { GarmentGenerationInput } from "./generation";
import {
  applyEvidenceGate,
  garmentFactKeys,
  type DesignDirection,
  type GarmentAnalysis,
  type GarmentFactKey,
} from "./garment-analysis";

const factLabels: Record<GarmentFactKey, string> = {
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

const changeAreaLabels: Record<DesignDirection["changes"][number]["area"], string> = {
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

function factValue(value: string | string[] | null): string {
  if (Array.isArray(value)) {
    return value.join("、");
  }
  return value ?? "";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export interface CompileAnalyzedPromptInput {
  readonly request: GarmentGenerationInput;
  readonly analysis: GarmentAnalysis;
  readonly direction: DesignDirection;
}

export interface CompileGarmentIterationPromptInput {
  readonly basePrompt: string;
  readonly revisionInstructions: readonly string[];
  readonly usesStableAnchorImage?: boolean;
}

export function compileAnalyzedGarmentPrompt(input: CompileAnalyzedPromptInput): string {
  const gate = applyEvidenceGate(input.analysis.visualFacts);
  const acceptedFacts = gate.accepted
    .filter(({ key }) => garmentFactKeys.includes(key))
    .map(({ key, fact }) => `${factLabels[key]}：${factValue(fact.value)}`);
  const preserve = unique([
    ...input.request.preserveItems,
    ...input.analysis.userConstraints.preserve,
    ...input.direction.preserve,
    ...input.direction.promptRequirements.hardConstraints,
  ]);
  const negatives = unique([
    ...input.analysis.userConstraints.avoid,
    ...input.direction.promptRequirements.negative,
    "人物",
    "品牌标志",
    "无关文字",
    "额外水印",
    "重复部件",
    "结构矛盾",
    "不可制作的悬空装饰",
  ]);
  const changes = input.direction.changes.map(
    (change, index) =>
      `${index + 1}. ${changeAreaLabels[change.area]}：${change.instruction}。设计理由：${change.reason}`,
  );

  return [
    "你是一名熟悉服装设计、打版与工艺的专业设计师。请基于输入服装图片完成一次真实、可生产的整体改款。",
    `业务模式：${input.request.mode === "inspiration" ? "设计灵感探索" : "服装档口快速衍生"}。改款幅度：${input.request.intensity}。`,
    `选定设计方向：${input.direction.name}。${input.direction.summary}`,
    `图片中经过证据门控的可信事实：\n${acceptedFacts.map((fact) => `- ${fact}`).join("\n") || "- 仅以输入图片可见内容为准"}`,
    `必须完整保留：\n${preserve.map((item) => `- ${item}`).join("\n")}`,
    `具体改款：\n${changes.join("\n")}`,
    `目标风格与正向要求：\n${unique([
      input.request.styleDirection,
      ...input.direction.promptRequirements.positive,
    ])
      .map((item) => `- ${item}`)
      .join("\n")}`,
    `用户补充要求：${input.request.changeRequest.trim()}`,
    "只把可信视觉事实作为原款描述。对 inferred、unknown 或低置信度区域，不得自行补充具体结构；除用户明确要求修改外，应尽量保持输入图原貌。",
    "所有新增结构必须符合真实裁片、缝制、受力和穿着逻辑，清晰呈现面料、缝线、口袋厚度和部件连接关系。",
    `禁止出现：${negatives.join("、")}。`,
  ].join("\n\n");
}

export function compileGarmentIterationPrompt(input: CompileGarmentIterationPromptInput): string {
  const revisionInstructions = unique(input.revisionInstructions);
  if (revisionInstructions.length === 0) {
    throw new Error("继续修改至少需要一条有效指令。");
  }

  const latestInstruction = revisionInstructions.at(-1);
  const sourceContext = input.usesStableAnchorImage
    ? "当前输入图片是本分支首次生成的稳定基准版，不是新的原款，也不是上一轮可能已经退化的结果。请从这张稳定基准版出发，在一次生成中完整执行下面所有累计修改；不得只执行最后一条。"
    : "当前输入图片是需要继续修改的上一版结果，不是新的原款。";
  const preservationTarget = input.usesStableAnchorImage ? "稳定基准版" : "上一版";

  return [
    `这是局部编辑任务。本轮重点：${latestInstruction}。只修改累计指令直接涉及的区域；没有被要求改变的结构、面料、颜色、白平衡和构图必须保持${preservationTarget}，各条累计修改不得互相覆盖。`,
    sourceContext,
    `累计追加修改（按顺序全部执行）：\n${revisionInstructions
      .map((instruction, index) => `${index + 1}. ${instruction}`)
      .join("\n")}`,
    "追加修改的优先级低于必须保留项和结构硬约束。若追加要求与硬约束冲突，以硬约束为准，不得为了执行局部修改破坏服装的可生产性。",
    "以下是原始任务约束，只用于继续校验硬约束和禁止项，不代表要恢复成最初上传的原图：",
    input.basePrompt.trim(),
  ].join("\n\n");
}
