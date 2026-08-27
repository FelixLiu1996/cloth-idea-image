import type {
  DesignIntensity,
  GarmentAnalysisApiResponse,
  GenerationApiResponse,
  GenerationMode,
} from "@cloth-idea/domain";
import { Button, Image, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useMemo, useRef, useState } from "react";

import {
  saveGeneratedImage,
  selectGarmentImage,
  type SelectedImage,
} from "../../platform/image-platform";
import {
  analyzeGarment,
  createGeneration,
  refineGeneration,
  type CreateGenerationRequest,
} from "../../services/generation-api";
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

const intensities: readonly { value: DesignIntensity; label: string }[] = [
  { value: "low", label: "轻改" },
  { value: "medium", label: "中改" },
  { value: "high", label: "大改" },
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
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(null);
  const [results, setResults] = useState<GenerationApiResponse[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [revisionInstruction, setRevisionInstruction] = useState("");

  const busy = analyzing || generating || refining;
  const canRequest = useMemo(
    () =>
      image !== null &&
      changeRequest.trim().length >= 2 &&
      styleDirection.trim().length >= 2 &&
      !busy,
    [busy, changeRequest, image, styleDirection],
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

  function clearDerivedState() {
    setAnalysisResult(null);
    setSelectedDirectionId(null);
    setResults([]);
    setActiveJobId(null);
    setRevisionInstruction("");
    setErrorMessage("");
  }

  function requestInput(): CreateGenerationRequest | null {
    if (!image) {
      return null;
    }
    return {
      imagePath: image.path,
      mode,
      preserveItems,
      changeRequest,
      styleDirection,
      intensity,
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
      const nextAnalysis = await analyzeGarment(input);
      setAnalysisResult(nextAnalysis);
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
      const nextResult = await createGeneration({
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
      const nextResult = await refineGeneration({
        parentJobId: activeResult.jobId,
        imagePath: image.path,
        instruction,
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

  return (
    <View className="page-shell">
      <View className="hero">
        <Text className="eyebrow">AI GARMENT STUDIO</Text>
        <Text className="hero-title">从一件原款，找到下一件好卖的衣服</Text>
        <Text className="hero-copy">
          先识别可信的原款结构，再选择设计方向，最后生成一张效果图。
        </Text>
      </View>

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

          <View className="direction-list">
            {analysisResult.analysis.designDirections.map((direction) => {
              const selected = selectedDirectionId === direction.id;
              const recommended = analysisResult.analysis.recommendedDirectionId === direction.id;
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
                    {recommended && <Text className="recommended-badge">推荐</Text>}
                  </View>
                  <Text className="direction-summary">{direction.summary}</Text>
                  <View className="change-list">
                    {direction.changes.map((change) => (
                      <Text key={`${change.area}-${change.instruction}`} className="change-item">
                        · {change.instruction}
                      </Text>
                    ))}
                  </View>
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

      {activeResult && image && (
        <View className="result-section">
          <View className="result-heading">
            <Text className="result-kicker">DESIGN READY</Text>
            <Text className="result-title">你的改款方案</Text>
            <Text className="result-summary">{activeResult.summary}</Text>
          </View>

          <View className="comparison-grid">
            <View className="comparison-item">
              <Text className="comparison-label">
                {activeResult.operation === "refine" && parentResult ? "上一版" : "原图"}
              </Text>
              <Image
                className="comparison-image"
                src={
                  activeResult.operation === "refine" && parentResult
                    ? parentResult.resultUrl
                    : image.path
                }
                mode="aspectFit"
              />
            </View>
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

          <View className="result-actions">
            <Button
              className="result-action result-action--primary"
              disabled={busy}
              onClick={() => generate(activeResult.strategy === "analyzed", activeResult)}
            >
              {generating ? "正在处理生成任务…" : "按此方向再生成"}
            </Button>
            <Button className="result-action" disabled={saving} onClick={downloadCurrentResult}>
              {saving ? "正在保存…" : "下载结果图"}
            </Button>
          </View>

          <View className="refinement-panel">
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
