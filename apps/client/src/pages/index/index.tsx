import type {
  DesignIntensity,
  GarmentAnalysisApiResponse,
  GenerationApiResponse,
  GenerationMode,
} from "@cloth-idea/domain";
import { Button, Image, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useMemo, useState } from "react";

import { selectGarmentImage, type SelectedImage } from "../../platform/image-platform";
import {
  analyzeGarment,
  createGeneration,
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

export default function Index() {
  const [mode, setMode] = useState<GenerationMode>("quick-derivative");
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [preserveItems, setPreserveItems] = useState("");
  const [changeRequest, setChangeRequest] = useState("");
  const [styleDirection, setStyleDirection] = useState("");
  const [intensity, setIntensity] = useState<DesignIntensity>("medium");
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [analysisResult, setAnalysisResult] = useState<GarmentAnalysisApiResponse | null>(null);
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(null);
  const [result, setResult] = useState<GenerationApiResponse | null>(null);

  const busy = analyzing || generating;
  const canRequest = useMemo(
    () =>
      image !== null &&
      changeRequest.trim().length >= 2 &&
      styleDirection.trim().length >= 2 &&
      !busy,
    [busy, changeRequest, image, styleDirection],
  );
  const canGenerateAnalyzed = canRequest && analysisResult !== null && selectedDirectionId !== null;

  function clearDerivedState() {
    setAnalysisResult(null);
    setSelectedDirectionId(null);
    setResult(null);
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
    if (!canRequest || !input) {
      return;
    }

    setAnalyzing(true);
    setErrorMessage("");
    setAnalysisResult(null);
    setSelectedDirectionId(null);
    setResult(null);
    try {
      const nextAnalysis = await analyzeGarment(input);
      setAnalysisResult(nextAnalysis);
      setSelectedDirectionId(nextAnalysis.analysis.recommendedDirectionId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "分析失败，请稍后重试。");
    } finally {
      setAnalyzing(false);
    }
  }

  async function generate(useAnalysis: boolean) {
    const input = requestInput();
    if (!canRequest || !input) {
      return;
    }
    if (useAnalysis && (!analysisResult || !selectedDirectionId)) {
      return;
    }

    setGenerating(true);
    setErrorMessage("");
    setResult(null);
    try {
      const nextResult = await createGeneration({
        ...input,
        ...(useAnalysis && analysisResult && selectedDirectionId
          ? { analysisId: analysisResult.analysisId, directionId: selectedDirectionId }
          : {}),
      });
      setResult(nextResult);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally {
      setGenerating(false);
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
              className={`mode-card ${mode === item.value ? "mode-card--active" : ""}`}
              onClick={() => {
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
        <View className={`upload-card ${image ? "upload-card--filled" : ""}`} onClick={chooseImage}>
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
              className={`intensity-option ${intensity === item.value ? "intensity-option--active" : ""}`}
              onClick={() => {
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
          <Button
            className="generate-button"
            disabled={!canRequest}
            loading={analyzing}
            onClick={analyze}
          >
            {analyzing ? "正在分析原款，预计 1–2 分钟…" : "分析原款并生成 3 个方向"}
          </Button>
          <Button
            className="text-button"
            disabled={!canRequest}
            loading={generating}
            onClick={() => generate(false)}
          >
            {generating ? "正在直接生成…" : "跳过分析，直接生成"}
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
                    setSelectedDirectionId(direction.id);
                    setResult(null);
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
            loading={generating}
            onClick={() => generate(true)}
          >
            {generating ? "正在按选中方向生成…" : "按选中方向生成效果图"}
          </Button>
          <Button className="text-button" disabled={busy} onClick={analyze}>
            重新分析原款
          </Button>
        </View>
      )}

      {result && (
        <View className="result-section">
          <View className="result-heading">
            <Text className="result-kicker">DESIGN READY</Text>
            <Text className="result-title">你的改款方案</Text>
            <Text className="result-summary">{result.summary}</Text>
          </View>
          <Image className="result-image" src={result.resultUrl} mode="widthFix" />
          <View className="result-meta">
            <Text>{result.directionName ?? "直接生成"}</Text>
            <Text>{Math.max(1, Math.round(result.durationMs / 1_000))} 秒</Text>
          </View>
        </View>
      )}
    </View>
  );
}
