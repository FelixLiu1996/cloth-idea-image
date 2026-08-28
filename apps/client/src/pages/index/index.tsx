import {
  createGarmentRefinementInstruction,
  createGarmentResultReviewPlan,
  createPreserveItemSuggestions,
  findDesignDirection,
  formatGarmentPreserveItem,
  garmentChangeAreaLabels,
  maximumConfirmedPreserveItems,
  maximumPreserveItemsTextLength,
  mergePreserveItems,
  parsePreserveItems,
  serializePreserveItems,
  type DesignIntensity,
  type GarmentAnalysisApiResponse,
  type GarmentResultReviewStatus,
  type GenerationApiResponse,
  type GenerationMode,
} from "@cloth-idea/domain";
import { Button, Image, Input, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  saveGeneratedImage,
  selectGarmentImage,
  type SelectedImage,
} from "../../platform/image-platform";
import { readTrialAccessCode, saveTrialAccessCode } from "../../platform/trial-access-platform";
import { garmentGateway } from "../../services/active-garment-gateway";
import type { CreateGenerationRequest } from "../../services/garment-gateway";
import "./index.scss";

const modes: readonly {
  value: GenerationMode;
  title: string;
  description: string;
  badge: string;
}[] = [
  {
    value: "inspiration",
    title: "设计灵感",
    description: "允许更明显的廓形、结构与工艺探索",
    badge: "适合设计师",
  },
  {
    value: "quick-derivative",
    title: "快速衍生",
    description: "兼顾原款识别度、可生产性与成本",
    badge: "适合服装档口",
  },
];

const intensities: readonly { value: DesignIntensity; label: string; description: string }[] = [
  { value: "low", label: "轻改", description: "主体版型基本不变，主要修改细节和工艺。" },
  { value: "medium", label: "中改", description: "保留识别特征，允许调整结构和比例。" },
  { value: "high", label: "大改", description: "只强制保留锁定项，允许整体重构。" },
];

const riskLabels = {
  low: "低生产风险",
  medium: "中等生产风险",
  high: "高生产风险",
} as const;

const operationLabels = {
  initial: "首次生成",
  regenerate: "同方向再生成",
  refine: "继续修改",
} as const;

const reviewKindLabels = {
  preservation: "保留项",
  change: "改款项",
  anomaly: "异常项",
} as const;

const reviewStatusLabels: Record<Exclude<GarmentResultReviewStatus, "pending">, string> = {
  pass: "通过",
  question: "存疑",
  fail: "未通过",
};

type ResultReviewMode = "idle" | "satisfied" | "issues" | "detailed";

function latestMatchingResult(
  results: readonly GenerationApiResponse[],
  strategy: GenerationApiResponse["strategy"],
  directionId: string | null,
): GenerationApiResponse | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const item = results[index];
    if (item?.strategy === strategy && item.directionId === directionId) {
      return item;
    }
  }
  return null;
}

export default function Index() {
  const modelRequestInFlight = useRef(false);
  const [mode, setMode] = useState<GenerationMode>("quick-derivative");
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [preserveItems, setPreserveItems] = useState("");
  const [changeRequest, setChangeRequest] = useState("");
  const [styleDirection, setStyleDirection] = useState("");
  const [intensity, setIntensity] = useState<DesignIntensity>("medium");
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [refining, setRefining] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [analysisResult, setAnalysisResult] = useState<GarmentAnalysisApiResponse | null>(null);
  const [analysisBasePreserveItems, setAnalysisBasePreserveItems] = useState<string[]>([]);
  const [confirmedPreserveItems, setConfirmedPreserveItems] = useState<string[]>([]);
  const [customPreserveItem, setCustomPreserveItem] = useState("");
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(null);
  const [results, setResults] = useState<GenerationApiResponse[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [trialAccessRequired, setTrialAccessRequired] = useState(false);
  const [trialAccessCode, setTrialAccessCode] = useState(readTrialAccessCode);
  const [reviewStatuses, setReviewStatuses] = useState<
    Record<string, Record<string, GarmentResultReviewStatus>>
  >({});
  const [reviewModes, setReviewModes] = useState<Record<string, ResultReviewMode>>({});

  useEffect(() => {
    let active = true;
    void garmentGateway
      .getTrialCapabilities()
      .then((capabilities) => {
        if (active) {
          setTrialAccessRequired(capabilities.trialAccessRequired);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void garmentGateway
      .restorePendingGeneration()
      .then((restored) => {
        if (!active || !restored) {
          return;
        }
        setResults((current) =>
          current.some((item) => item.jobId === restored.jobId) ? current : [...current, restored],
        );
        setActiveJobId(restored.jobId);
        setSelectedDirectionId(restored.directionId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const busy = analyzing || generating || refining;
  const canRequest = useMemo(
    () =>
      image !== null &&
      changeRequest.trim().length >= 2 &&
      styleDirection.trim().length >= 2 &&
      (!trialAccessRequired || trialAccessCode.trim().length > 0) &&
      !busy,
    [busy, changeRequest, image, styleDirection, trialAccessCode, trialAccessRequired],
  );
  const canGenerateAnalyzed = canRequest && analysisResult !== null && selectedDirectionId !== null;
  const activeResult = useMemo(
    () => results.find((item) => item.jobId === activeJobId) ?? null,
    [activeJobId, results],
  );
  const parentResult = useMemo(
    () =>
      activeResult?.parentJobId
        ? (results.find((item) => item.jobId === activeResult.parentJobId) ?? null)
        : null,
    [activeResult, results],
  );
  const latestSelectedDirectionResult = useMemo(
    () =>
      selectedDirectionId ? latestMatchingResult(results, "analyzed", selectedDirectionId) : null,
    [results, selectedDirectionId],
  );
  const latestDirectResult = useMemo(
    () => latestMatchingResult(results, "direct", null),
    [results],
  );
  const preserveSuggestions = useMemo(
    () => (analysisResult ? createPreserveItemSuggestions(analysisResult.analysis) : []),
    [analysisResult],
  );
  const selectedIntensity = intensities.find((item) => item.value === intensity) ?? intensities[1]!;
  const activeDirection = useMemo(
    () =>
      analysisResult && activeResult?.directionId
        ? findDesignDirection(analysisResult.analysis, activeResult.directionId)
        : null,
    [activeResult, analysisResult],
  );
  const activeReviewPlan = useMemo(() => {
    if (!activeResult) {
      return [];
    }
    const preserveForResult =
      activeResult.strategy === "analyzed"
        ? confirmedPreserveItems
        : parsePreserveItems(preserveItems);
    return createGarmentResultReviewPlan({
      preserveItems: preserveForResult,
      direction: activeDirection,
    });
  }, [activeDirection, activeResult, confirmedPreserveItems, preserveItems]);
  const activeReviewStatuses = activeResult ? (reviewStatuses[activeResult.jobId] ?? {}) : {};
  const activeReviewMode = activeResult ? (reviewModes[activeResult.jobId] ?? "idle") : "idle";
  const selectedReviewIssues = activeReviewPlan.filter((item) => {
    const status = activeReviewStatuses[item.id] ?? "pending";
    return status === "question" || status === "fail";
  });
  const locksFrozen = results.length > 0;

  function clearDerivedState() {
    setAnalysisResult(null);
    setAnalysisBasePreserveItems([]);
    setConfirmedPreserveItems([]);
    setCustomPreserveItem("");
    setSelectedDirectionId(null);
    setResults([]);
    setActiveJobId(null);
    setRevisionInstruction("");
    setReviewStatuses({});
    setReviewModes({});
    setErrorMessage("");
  }

  function requestInput(): CreateGenerationRequest | null {
    if (!image) {
      return null;
    }
    return {
      imagePath: image.path,
      imageSize: image.size,
      mode,
      preserveItems: analysisResult
        ? serializePreserveItems(confirmedPreserveItems)
        : preserveItems,
      changeRequest,
      styleDirection,
      intensity,
      ...(trialAccessCode.trim() ? { accessCode: trialAccessCode.trim() } : {}),
    };
  }

  async function chooseImage() {
    if (busy || modelRequestInFlight.current) {
      return;
    }
    const selected = await selectGarmentImage();
    if (selected) {
      if (selected.size > 10 * 1024 * 1024) {
        await Taro.showToast({ title: "图片不能超过 10 MB", icon: "none" });
        return;
      }
      setImage(selected);
      clearDerivedState();
    }
  }

  async function analyze() {
    const input = requestInput();
    if (!canRequest || !input || modelRequestInFlight.current) {
      return;
    }

    modelRequestInFlight.current = true;
    setAnalyzing(true);
    setErrorMessage("");
    setAnalysisResult(null);
    setSelectedDirectionId(null);
    setResults([]);
    setActiveJobId(null);
    setRevisionInstruction("");
    try {
      const nextAnalysis = await garmentGateway.analyzeGarment(input);
      const basePreserveItems = [...parsePreserveItems(input.preserveItems)];
      setAnalysisResult(nextAnalysis);
      setAnalysisBasePreserveItems(basePreserveItems);
      setConfirmedPreserveItems(basePreserveItems);
      setCustomPreserveItem("");
      setSelectedDirectionId(nextAnalysis.analysis.recommendedDirectionId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "分析失败，请稍后重试。");
    } finally {
      modelRequestInFlight.current = false;
      setAnalyzing(false);
    }
  }

  async function generate(useAnalysis: boolean, parentOverride?: GenerationApiResponse | null) {
    const input = requestInput();
    if (!canRequest || !input || modelRequestInFlight.current) {
      return;
    }
    if (useAnalysis && (!analysisResult || !selectedDirectionId)) {
      return;
    }

    modelRequestInFlight.current = true;
    setGenerating(true);
    setErrorMessage("");
    try {
      const parent =
        parentOverride === undefined
          ? useAnalysis
            ? latestMatchingResult(results, "analyzed", selectedDirectionId)
            : latestMatchingResult(results, "direct", null)
          : parentOverride;
      const nextResult = await garmentGateway.createGeneration({
        ...input,
        ...(useAnalysis && analysisResult && selectedDirectionId
          ? { analysisId: analysisResult.analysisId, directionId: selectedDirectionId }
          : {}),
        ...(parent ? { parentJobId: parent.jobId } : {}),
      });
      setResults((current) =>
        current.some((item) => item.jobId === nextResult.jobId)
          ? current
          : [...current, nextResult],
      );
      setActiveJobId(nextResult.jobId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally {
      modelRequestInFlight.current = false;
      setGenerating(false);
    }
  }

  async function refineCurrentResult() {
    const instruction = revisionInstruction.trim();
    if (!activeResult || !image || instruction.length < 2 || busy || modelRequestInFlight.current) {
      return;
    }

    modelRequestInFlight.current = true;
    setRefining(true);
    setErrorMessage("");
    try {
      const nextResult = await garmentGateway.refineGeneration({
        parentJobId: activeResult.jobId,
        imagePath: image.path,
        imageSize: image.size,
        instruction,
        ...(trialAccessCode.trim() ? { accessCode: trialAccessCode.trim() } : {}),
      });
      setResults((current) =>
        current.some((item) => item.jobId === nextResult.jobId)
          ? current
          : [...current, nextResult],
      );
      setActiveJobId(nextResult.jobId);
      setSelectedDirectionId(nextResult.directionId);
      setRevisionInstruction("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "继续修改失败，请稍后重试。");
    } finally {
      modelRequestInFlight.current = false;
      setRefining(false);
    }
  }

  async function downloadCurrentResult() {
    if (!activeResult || saving) {
      return;
    }

    setSaving(true);
    setErrorMessage("");
    try {
      await saveGeneratedImage(activeResult.resultUrl);
      await Taro.showToast({ title: "图片已保存", icon: "success" });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "图片保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  function trySetConfirmedPreserveItems(items: readonly string[]): boolean {
    const nextItems = [...mergePreserveItems(items)];
    if (
      nextItems.length > maximumConfirmedPreserveItems ||
      serializePreserveItems(nextItems).length > maximumPreserveItemsTextLength
    ) {
      void Taro.showToast({ title: "保留项已达到上限", icon: "none" });
      return false;
    }
    setConfirmedPreserveItems(nextItems);
    return true;
  }

  function addConfirmedPreserveItem(item: string): void {
    if (busy || locksFrozen) {
      return;
    }
    if (
      !confirmedPreserveItems.includes(item.trim()) &&
      confirmedPreserveItems.length >= maximumConfirmedPreserveItems
    ) {
      void Taro.showToast({ title: "最多锁定 16 项", icon: "none" });
      return;
    }
    trySetConfirmedPreserveItems([...confirmedPreserveItems, item]);
  }

  function removeConfirmedPreserveItem(item: string): void {
    if (busy || locksFrozen) {
      return;
    }
    if (analysisBasePreserveItems.includes(item)) {
      void Taro.showToast({ title: "请在上方修改原始保留项并重新分析", icon: "none" });
      return;
    }
    setConfirmedPreserveItems((current) => current.filter((candidate) => candidate !== item));
  }

  function addCustomPreserveItem(): void {
    const item = customPreserveItem.trim();
    if (!item || busy || locksFrozen) {
      return;
    }
    if (trySetConfirmedPreserveItems([...confirmedPreserveItems, item])) {
      setCustomPreserveItem("");
    }
  }

  function updateReviewStatus(itemId: string, status: GarmentResultReviewStatus): void {
    if (!activeResult) {
      return;
    }
    setReviewStatuses((current) => ({
      ...current,
      [activeResult.jobId]: {
        ...current[activeResult.jobId],
        [itemId]: status,
      },
    }));
  }

  function setActiveReviewMode(mode: ResultReviewMode): void {
    if (!activeResult) {
      return;
    }
    setReviewModes((current) => ({ ...current, [activeResult.jobId]: mode }));
  }

  function markActiveResultSatisfied(): void {
    if (!activeResult) {
      return;
    }
    setReviewStatuses((current) => ({
      ...current,
      [activeResult.jobId]: Object.fromEntries(
        activeReviewPlan.map((item) => [item.id, "pass" as const]),
      ),
    }));
    setActiveReviewMode("satisfied");
  }

  function toggleReviewIssue(itemId: string): void {
    const currentStatus = activeReviewStatuses[itemId] ?? "pending";
    updateReviewStatus(
      itemId,
      currentStatus === "fail" || currentStatus === "question" ? "pending" : "fail",
    );
  }

  function applySelectedReviewIssues(): void {
    if (!image || selectedReviewIssues.length === 0) {
      return;
    }
    setRevisionInstruction(createGarmentRefinementInstruction(selectedReviewIssues));
    void Taro.showToast({ title: "已填入下方修改要求", icon: "success" });
    void Taro.pageScrollTo({ selector: "#refinement-panel", duration: 300 });
  }

  return (
    <View className={`page-shell ${process.env.TARO_ENV === "weapp" ? "page-shell--weapp" : ""}`}>
      <View className="hero">
        <Text className="eyebrow">AI GARMENT STUDIO</Text>
        <Text className="hero-title">从一件原款，找到下一件好卖的衣服</Text>
        <Text className="hero-copy">
          先识别可信的原款结构，再选择设计方向，最后生成一张效果图。
        </Text>
        {process.env.TARO_ENV === "weapp" && (
          <Button
            className="cloud-diagnostics-entry"
            onClick={() => Taro.navigateTo({ url: "/pages/cloud-diagnostics/index" })}
          >
            云开发诊断
          </Button>
        )}
      </View>

      {trialAccessRequired && (
        <View className="access-card">
          <Text className="access-title">小范围试用</Text>
          <Text className="access-copy">请输入邀请方提供的访问码，模型密钥不会发送到设备端。</Text>
          <Input
            className="access-input"
            disabled={busy}
            password
            value={trialAccessCode}
            maxlength={128}
            placeholder="试用访问码"
            onInput={(event) => setTrialAccessCode(event.detail.value)}
            onBlur={() => saveTrialAccessCode(trialAccessCode)}
          />
        </View>
      )}

      <View className="section">
        <View className="section-heading">
          <Text className="step-number">01</Text>
          <Text className="section-title">选择使用场景</Text>
        </View>
        <View className="mode-grid">
          {modes.map((item) => (
            <View
              key={item.value}
              className={`mode-card ${mode === item.value ? "mode-card--active" : ""} ${busy ? "mode-card--disabled" : ""}`}
              onClick={() => {
                if (busy) {
                  return;
                }
                setMode(item.value);
                clearDerivedState();
              }}
            >
              <Text className="mode-badge">{item.badge}</Text>
              <Text className="mode-title">{item.title}</Text>
              <Text className="mode-copy">{item.description}</Text>
            </View>
          ))}
        </View>
      </View>

      <View className="section">
        <View className="section-heading">
          <Text className="step-number">02</Text>
          <Text className="section-title">上传原款图片</Text>
        </View>
        <View
          className={`upload-card ${image ? "upload-card--filled" : ""} ${busy ? "upload-card--disabled" : ""}`}
          onClick={chooseImage}
        >
          {image ? (
            <>
              <Image className="source-image" src={image.path} mode="aspectFit" />
              <View className="replace-pill">点击更换</View>
            </>
          ) : (
            <>
              <Text className="upload-mark">＋</Text>
              <Text className="upload-title">拍照或从相册选择</Text>
              <Text className="upload-hint">JPG / PNG / WEBP，最大 10 MB</Text>
            </>
          )}
        </View>
      </View>

      <View className="section form-section">
        <View className="section-heading">
          <Text className="step-number">03</Text>
          <Text className="section-title">写下改款方向</Text>
        </View>

        <Text className="field-label">必须保留</Text>
        <Textarea
          className="field-input field-input--short"
          disabled={busy}
          value={preserveItems}
          maxlength={500}
          placeholder="例如：黑白格纹袖口、深蓝牛仔面料"
          onInput={(event) => {
            setPreserveItems(event.detail.value);
            clearDerivedState();
          }}
        />
        <Text className="field-tip">多个保留项可用逗号分隔，它们会作为生图硬约束。</Text>

        <Text className="field-label">想怎么改</Text>
        <Textarea
          className="field-input"
          disabled={busy}
          value={changeRequest}
          maxlength={1_000}
          placeholder="例如：调整为复古工装短夹克，重做整体廓形、结构分割、门襟、口袋和五金"
          onInput={(event) => {
            setChangeRequest(event.detail.value);
            clearDerivedState();
          }}
        />

        <Text className="field-label">目标风格</Text>
        <Textarea
          className="field-input field-input--short"
          disabled={busy}
          value={styleDirection}
          maxlength={500}
          placeholder="例如：90 年代日系复古工装，真实可打样"
          onInput={(event) => {
            setStyleDirection(event.detail.value);
            clearDerivedState();
          }}
        />

        <Text className="field-label">改款幅度</Text>
        <View className="intensity-control">
          {intensities.map((item) => (
            <View
              key={item.value}
              className={`intensity-option ${intensity === item.value ? "intensity-option--active" : ""} ${busy ? "intensity-option--disabled" : ""}`}
              onClick={() => {
                if (busy) {
                  return;
                }
                setIntensity(item.value);
                clearDerivedState();
              }}
            >
              {item.label}
            </View>
          ))}
        </View>
        <Text className="intensity-description">{selectedIntensity.description}</Text>
      </View>

      {errorMessage && <View className="error-card">{errorMessage}</View>}

      {!analysisResult && (
        <>
          <Button className="generate-button" disabled={!canRequest} onClick={analyze}>
            {analyzing ? "正在分析原款，预计 1–2 分钟…" : "分析原款并生成 3 个方向"}
          </Button>
          <Button className="text-button" disabled={!canRequest} onClick={() => generate(false)}>
            {generating
              ? "正在创建并处理生成任务…"
              : latestDirectResult
                ? "按原要求再生成一版"
                : "跳过分析，直接生成"}
          </Button>
        </>
      )}
      <Text className="privacy-note">原图仅用于当前请求；模型密钥不会发送到手机端</Text>

      {analysisResult && (
        <View className="section analysis-section">
          <View className="section-heading">
            <Text className="step-number">04</Text>
            <View>
              <Text className="section-title">选择设计方向</Text>
              <Text className="analysis-meta">
                采纳 {analysisResult.evidenceSummary.accepted} 项可见事实 · 待复核{" "}
                {analysisResult.evidenceSummary.needsReview} 项 · 未知{" "}
                {analysisResult.evidenceSummary.unknown} 项
              </Text>
            </View>
          </View>

          <View className="preserve-confirmation">
            <View className="preserve-confirmation-heading">
              <View>
                <Text className="preserve-confirmation-title">确认本次锁定项</Text>
                <Text className="preserve-confirmation-copy">
                  AI 只提供高置信度可见事实作为候选；只有你确认的内容才会成为生图硬约束。
                </Text>
              </View>
              <Text className="preserve-count">
                {confirmedPreserveItems.length}/{maximumConfirmedPreserveItems}
              </Text>
            </View>

            {confirmedPreserveItems.length > 0 ? (
              <View className="confirmed-preserve-list">
                {confirmedPreserveItems.map((item) => {
                  const fromOriginalBrief = analysisBasePreserveItems.includes(item);
                  return (
                    <View
                      key={item}
                      className={`confirmed-preserve-chip ${fromOriginalBrief ? "confirmed-preserve-chip--original" : ""}`}
                      onClick={() => removeConfirmedPreserveItem(item)}
                    >
                      <Text>{item}</Text>
                      <Text className="confirmed-preserve-source">
                        {fromOriginalBrief ? "你填写" : "移除 ×"}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text className="preserve-empty">尚未锁定具体元素，模型只会维持基本品类与主体。</Text>
            )}

            <Text className="preserve-subtitle">AI 识别的可见事实</Text>
            <View className="preserve-suggestion-list">
              {preserveSuggestions
                .filter((suggestion) => !confirmedPreserveItems.includes(suggestion.preserveItem))
                .map((suggestion) => (
                  <View
                    key={suggestion.id}
                    className={`preserve-suggestion ${busy || locksFrozen ? "preserve-suggestion--disabled" : ""}`}
                    onClick={() => addConfirmedPreserveItem(suggestion.preserveItem)}
                  >
                    <Text className="preserve-suggestion-label">＋ {suggestion.label}</Text>
                    <Text className="preserve-suggestion-value">{suggestion.value}</Text>
                    <Text className="preserve-suggestion-confidence">
                      可信度 {Math.round(suggestion.confidence * 100)}%
                    </Text>
                  </View>
                ))}
            </View>
            {preserveSuggestions.length === 0 ? (
              <Text className="preserve-empty">没有可直接作为候选的高置信度可见事实。</Text>
            ) : (
              preserveSuggestions.every((suggestion) =>
                confirmedPreserveItems.includes(suggestion.preserveItem),
              ) && <Text className="preserve-empty">当前可见事实已经全部处理。</Text>
            )}

            <View className="custom-preserve-row">
              <Input
                className="custom-preserve-input"
                disabled={busy || locksFrozen}
                value={customPreserveItem}
                maxlength={100}
                placeholder="补充一个需要保留的元素"
                onInput={(event) => setCustomPreserveItem(event.detail.value)}
                onConfirm={() => addCustomPreserveItem()}
              />
              <Button
                className="custom-preserve-button"
                disabled={busy || locksFrozen || customPreserveItem.trim().length === 0}
                onClick={addCustomPreserveItem}
              >
                加入
              </Button>
            </View>
            <Text className="preserve-footnote">
              {locksFrozen
                ? "本轮已有生成版本，锁定项已冻结；需要调整时请重新分析，避免历史版本与新约束混淆。"
                : "上方“必须保留”是本次分析的原始硬约束；修改它会重新开始分析。"}
            </Text>
          </View>

          <View className="direction-list">
            {analysisResult.analysis.designDirections.map((direction) => {
              const selected = selectedDirectionId === direction.id;
              const recommended = analysisResult.analysis.recommendedDirectionId === direction.id;
              const directionPreserveItems = mergePreserveItems(
                confirmedPreserveItems,
                direction.preserve,
              );
              return (
                <View
                  key={direction.id}
                  className={`direction-card ${selected ? "direction-card--active" : ""}`}
                  onClick={() => {
                    if (busy) {
                      return;
                    }
                    setSelectedDirectionId(direction.id);
                    const existing = latestMatchingResult(results, "analyzed", direction.id);
                    setActiveJobId(existing?.jobId ?? null);
                    setRevisionInstruction("");
                  }}
                >
                  <View className="direction-heading">
                    <Text className="direction-name">{direction.name}</Text>
                    <View className="direction-badges">
                      {selected && <Text className="selected-badge">已选择</Text>}
                      {recommended && <Text className="recommended-badge">推荐</Text>}
                    </View>
                  </View>
                  <Text className="direction-summary">{direction.summary}</Text>
                  <View className="direction-area-list">
                    {[...new Set(direction.changes.map((change) => change.area))].map((area) => (
                      <Text key={area} className="direction-area-chip">
                        {garmentChangeAreaLabels[area]}
                      </Text>
                    ))}
                  </View>
                  {selected ? (
                    <>
                      {recommended && (
                        <Text className="recommendation-reason">
                          推荐理由：{analysisResult.analysis.recommendationReason}
                        </Text>
                      )}
                      <View className="direction-overview">
                        <Text className="direction-overview-label">改款幅度</Text>
                        <Text className="direction-overview-value">{selectedIntensity.label}</Text>
                        <Text className="direction-overview-copy">
                          {selectedIntensity.description}
                        </Text>
                      </View>
                      <View className="direction-preserve-block">
                        <Text className="direction-detail-title">继承的保留项</Text>
                        <View className="direction-preserve-list">
                          {directionPreserveItems.map((item) => (
                            <Text key={item} className="direction-preserve-chip">
                              {formatGarmentPreserveItem(item)}
                            </Text>
                          ))}
                        </View>
                      </View>
                      <Text className="direction-detail-title direction-detail-title--changes">
                        主要变化
                      </Text>
                      <View className="change-list">
                        {direction.changes.map((change) => (
                          <View
                            key={`${change.area}-${change.instruction}`}
                            className="change-item"
                          >
                            <Text className="change-area">
                              {garmentChangeAreaLabels[change.area]}
                            </Text>
                            <View className="change-content">
                              <Text className="change-instruction">{change.instruction}</Text>
                              <Text className="change-reason">{change.reason}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    </>
                  ) : (
                    <Text className="direction-expand-hint">点击查看保留项和完整改款清单</Text>
                  )}
                  <Text className={`risk-label risk-label--${direction.productionRisk.level}`}>
                    {riskLabels[direction.productionRisk.level]} · {direction.productionRisk.reason}
                  </Text>
                </View>
              );
            })}
          </View>

          {analysisResult.analysis.conflictsOrQuestions.length > 0 && (
            <View className="review-note">
              <Text className="review-title">分析提醒</Text>
              {analysisResult.analysis.conflictsOrQuestions.map((question) => (
                <Text key={question} className="review-item">
                  · {question}
                </Text>
              ))}
            </View>
          )}

          <Button
            className="generate-button"
            disabled={!canGenerateAnalyzed}
            onClick={() => generate(true)}
          >
            {generating
              ? "正在创建并处理生成任务…"
              : latestSelectedDirectionResult
                ? "按选中方向再生成一版"
                : "按选中方向生成效果图"}
          </Button>
          <Button className="text-button" disabled={busy} onClick={analyze}>
            重新分析原款
          </Button>
        </View>
      )}

      {activeResult && (
        <View className="result-section">
          <View className="result-heading">
            <Text className="result-kicker">DESIGN READY</Text>
            <Text className="result-title">你的改款方案</Text>
            <Text className="result-summary">{activeResult.summary}</Text>
          </View>

          <View
            className={`comparison-grid ${!image && !parentResult ? "comparison-grid--single" : ""}`}
          >
            {(image || parentResult) && (
              <View className="comparison-item">
                <Text className="comparison-label">
                  {activeResult.operation === "refine" && parentResult ? "上一版" : "原图"}
                </Text>
                <Image
                  className="comparison-image"
                  src={
                    activeResult.operation === "refine" && parentResult
                      ? parentResult.resultUrl
                      : image!.path
                  }
                  mode="aspectFit"
                />
              </View>
            )}
            <View className="comparison-item">
              <Text className="comparison-label comparison-label--current">当前结果</Text>
              <Image className="comparison-image" src={activeResult.resultUrl} mode="aspectFit" />
            </View>
          </View>

          <View className="result-meta">
            <Text>{activeResult.directionName ?? "直接生成"}</Text>
            <Text>
              {operationLabels[activeResult.operation]} ·{" "}
              {Math.max(1, Math.round(activeResult.durationMs / 1_000))} 秒
            </Text>
          </View>

          <View className="result-review-panel">
            <View className="result-review-heading">
              <View>
                <Text className="result-review-title">这版效果怎么样？</Text>
                <Text className="result-review-copy">
                  不需要逐项确认；满意可以直接使用，有问题时再展开清单。
                </Text>
              </View>
              {activeReviewMode === "detailed" && (
                <Text className="result-review-progress">
                  {
                    activeReviewPlan.filter(
                      (item) => (activeReviewStatuses[item.id] ?? "pending") !== "pending",
                    ).length
                  }
                  /{activeReviewPlan.length}
                </Text>
              )}
            </View>

            {activeReviewMode === "idle" && (
              <>
                <View className="review-quick-actions">
                  <Button
                    className="review-quick-action review-quick-action--satisfied"
                    onClick={markActiveResultSatisfied}
                  >
                    <Text className="review-quick-action-title">满意，直接使用</Text>
                    <Text className="review-quick-action-copy">保存图片或按此方向再生成</Text>
                  </Button>
                  <Button
                    className="review-quick-action review-quick-action--issues"
                    onClick={() => setActiveReviewMode("issues")}
                  >
                    <Text className="review-quick-action-title">需要修改</Text>
                    <Text className="review-quick-action-copy">勾选问题并自动填写修改要求</Text>
                  </Button>
                </View>
                <View
                  className="review-secondary-link"
                  onClick={() => setActiveReviewMode("detailed")}
                >
                  详细核对（可选）
                </View>
              </>
            )}

            {activeReviewMode === "satisfied" && (
              <View className="review-resolution">
                <Text className="review-resolution-title">已记录：这版满意</Text>
                <Text className="review-resolution-copy">
                  可以直接下载；这项记录仅保留在当前页面，不会额外调用模型。
                </Text>
                <View className="review-resolution-actions">
                  <View
                    className="review-secondary-link"
                    onClick={() => setActiveReviewMode("issues")}
                  >
                    发现问题，需要修改
                  </View>
                  <View
                    className="review-secondary-link"
                    onClick={() => setActiveReviewMode("detailed")}
                  >
                    详细核对
                  </View>
                </View>
              </View>
            )}

            {activeReviewMode === "issues" && (
              <>
                <View className="review-issue-heading">
                  <Text className="review-issue-title">勾选需要修正的问题</Text>
                  <Text className="review-issue-count">已选 {selectedReviewIssues.length} 项</Text>
                </View>
                <Text className="review-issue-copy">
                  正常的项目不用点击，只选择确实有问题的部分。
                </Text>
                <View className="review-issue-list">
                  {activeReviewPlan.map((item) => {
                    const status = activeReviewStatuses[item.id] ?? "pending";
                    const selected = status === "question" || status === "fail";
                    return (
                      <View
                        key={item.id}
                        className={`review-issue-item ${selected ? "review-issue-item--selected" : ""}`}
                        onClick={() => toggleReviewIssue(item.id)}
                      >
                        <Text className="review-issue-check">{selected ? "✓" : ""}</Text>
                        <View className="review-issue-content">
                          <Text className={`review-kind review-kind--${item.kind}`}>
                            {reviewKindLabels[item.kind]}
                          </Text>
                          <Text className="review-issue-item-title">{item.title}</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
                <Button
                  className="review-apply-button"
                  disabled={!image || selectedReviewIssues.length === 0}
                  onClick={applySelectedReviewIssues}
                >
                  {!image
                    ? "重新上传原图后可继续修改"
                    : selectedReviewIssues.length === 0
                      ? "请先勾选问题"
                      : `将 ${selectedReviewIssues.length} 个问题填入修改要求`}
                </Button>
                <View className="review-resolution-actions">
                  <View
                    className="review-secondary-link"
                    onClick={() => setActiveReviewMode("idle")}
                  >
                    返回
                  </View>
                  <View
                    className="review-secondary-link"
                    onClick={() => setActiveReviewMode("detailed")}
                  >
                    切换到详细核对
                  </View>
                </View>
              </>
            )}

            {activeReviewMode === "detailed" && (
              <>
                <Text className="review-detail-note">
                  详细核对仅用于专业评审；存疑和未通过项目可自动整理成修改要求。
                </Text>
                <View className="result-review-list">
                  {activeReviewPlan.map((item) => {
                    const status = activeReviewStatuses[item.id] ?? "pending";
                    return (
                      <View
                        key={item.id}
                        className={`result-review-item result-review-item--${status}`}
                      >
                        <View className="result-review-item-heading">
                          <Text className={`review-kind review-kind--${item.kind}`}>
                            {reviewKindLabels[item.kind]}
                          </Text>
                          <Text className="review-current-status">
                            {status === "pending" ? "待确认" : reviewStatusLabels[status]}
                          </Text>
                        </View>
                        <Text className="result-review-item-title">{item.title}</Text>
                        <Text className="result-review-instruction">{item.instruction}</Text>
                        <View className="review-status-actions">
                          {(
                            Object.keys(reviewStatusLabels) as Exclude<
                              GarmentResultReviewStatus,
                              "pending"
                            >[]
                          ).map((nextStatus) => (
                            <View
                              key={nextStatus}
                              className={`review-status-action review-status-action--${nextStatus} ${status === nextStatus ? "review-status-action--active" : ""}`}
                              onClick={() => updateReviewStatus(item.id, nextStatus)}
                            >
                              {reviewStatusLabels[nextStatus]}
                            </View>
                          ))}
                        </View>
                      </View>
                    );
                  })}
                </View>
                {selectedReviewIssues.length > 0 && (
                  <Button
                    className="review-apply-button"
                    disabled={!image}
                    onClick={applySelectedReviewIssues}
                  >
                    {!image
                      ? "重新上传原图后可继续修改"
                      : `将 ${selectedReviewIssues.length} 个问题填入修改要求`}
                  </Button>
                )}
                <View
                  className="review-secondary-link review-secondary-link--standalone"
                  onClick={() => setActiveReviewMode("idle")}
                >
                  返回简洁模式
                </View>
              </>
            )}
          </View>

          <View className="result-actions">
            <Button
              className="result-action result-action--primary"
              disabled={busy || !image || (activeResult.strategy === "analyzed" && !analysisResult)}
              onClick={() => generate(activeResult.strategy === "analyzed", activeResult)}
            >
              {generating
                ? "正在处理生成任务…"
                : !image || (activeResult.strategy === "analyzed" && !analysisResult)
                  ? "重新开始后可再生成"
                  : "按此方向再生成"}
            </Button>
            <Button className="result-action" disabled={saving} onClick={downloadCurrentResult}>
              {saving ? "正在保存…" : "下载结果图"}
            </Button>
          </View>

          {image ? (
            <View id="refinement-panel" className="refinement-panel">
              <Text className="refinement-title">继续修改当前结果</Text>
              <Text className="refinement-copy">
                系统会从原图重新生成下一版，原始保留项、选中方向和累计修改继续生效。
              </Text>
              <Textarea
                className="refinement-input"
                value={revisionInstruction}
                maxlength={500}
                placeholder="例如：袖型再宽松一点，门襟改为隐藏拉链，其余保持不变"
                onInput={(event) => setRevisionInstruction(event.detail.value)}
              />
              <Button
                className="refinement-button"
                disabled={busy || revisionInstruction.trim().length < 2}
                onClick={refineCurrentResult}
              >
                {refining ? "正在处理修改任务…" : "生成修改后的下一版"}
              </Button>
            </View>
          ) : (
            <View className="refinement-panel">
              <Text className="refinement-title">已恢复云端结果</Text>
              <Text className="refinement-copy">
                当前设备没有保留原图临时文件，你仍可保存结果；如需继续修改，请重新上传原图并重新开始。
              </Text>
            </View>
          )}
        </View>
      )}

      {results.length > 0 && (
        <View className="section history-section">
          <View className="history-heading">
            <Text className="section-title">本次生成历史</Text>
            <Text className="history-count">{results.length} 个版本</Text>
          </View>
          <View className="history-grid">
            {results.map((item, index) => (
              <View
                key={item.jobId}
                className={`history-card ${item.jobId === activeJobId ? "history-card--active" : ""}`}
                onClick={() => {
                  setActiveJobId(item.jobId);
                  setSelectedDirectionId(item.directionId);
                  setRevisionInstruction("");
                }}
              >
                <Image className="history-image" src={item.resultUrl} mode="aspectFill" />
                <Text className="history-version">版本 {index + 1}</Text>
                <Text className="history-name">{item.directionName ?? "直接生成"}</Text>
                <Text className="history-operation">{operationLabels[item.operation]}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
