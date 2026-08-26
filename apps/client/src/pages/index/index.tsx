import { Button, Image, Text, Textarea, View } from "@tarojs/components";
import type { DesignIntensity, GenerationApiResponse, GenerationMode } from "@cloth-idea/domain";
import Taro from "@tarojs/taro";
import { useMemo, useState } from "react";

import { selectGarmentImage, type SelectedImage } from "../../platform/image-platform";
import { createGeneration } from "../../services/generation-api";
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

export default function Index() {
  const [mode, setMode] = useState<GenerationMode>("quick-derivative");
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [preserveItems, setPreserveItems] = useState("");
  const [changeRequest, setChangeRequest] = useState("");
  const [styleDirection, setStyleDirection] = useState("");
  const [intensity, setIntensity] = useState<DesignIntensity>("medium");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState<GenerationApiResponse | null>(null);

  const canSubmit = useMemo(
    () =>
      image !== null &&
      changeRequest.trim().length >= 2 &&
      styleDirection.trim().length >= 2 &&
      !submitting,
    [changeRequest, image, styleDirection, submitting],
  );

  async function chooseImage() {
    const selected = await selectGarmentImage();
    if (selected) {
      if (selected.size > 10 * 1024 * 1024) {
        await Taro.showToast({ title: "图片不能超过 10 MB", icon: "none" });
        return;
      }
      setImage(selected);
      setResult(null);
      setErrorMessage("");
    }
  }

  async function submit() {
    if (!canSubmit || !image) {
      return;
    }

    setSubmitting(true);
    setErrorMessage("");
    setResult(null);
    try {
      const nextResult = await createGeneration({
        imagePath: image.path,
        mode,
        preserveItems,
        changeRequest,
        styleDirection,
        intensity,
      });
      setResult(nextResult);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="page-shell">
      <View className="hero">
        <Text className="eyebrow">AI GARMENT STUDIO</Text>
        <Text className="hero-title">从一件原款，找到下一件好卖的衣服</Text>
        <Text className="hero-copy">上传服装图，锁定必须保留的设计，再让 AI 做整体改款。</Text>
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
              onClick={() => setMode(item.value)}
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
          onInput={(event) => setPreserveItems(event.detail.value)}
        />
        <Text className="field-tip">多个保留项可用逗号分隔，AI 会把它们当作硬约束。</Text>

        <Text className="field-label">想怎么改</Text>
        <Textarea
          className="field-input"
          value={changeRequest}
          maxlength={1_000}
          placeholder="例如：调整为复古工装短夹克，重做整体廓形、结构分割、门襟、口袋和五金"
          onInput={(event) => setChangeRequest(event.detail.value)}
        />

        <Text className="field-label">目标风格</Text>
        <Textarea
          className="field-input field-input--short"
          value={styleDirection}
          maxlength={500}
          placeholder="例如：90 年代日系复古工装，真实可打样"
          onInput={(event) => setStyleDirection(event.detail.value)}
        />

        <Text className="field-label">改款幅度</Text>
        <View className="intensity-control">
          {intensities.map((item) => (
            <View
              key={item.value}
              className={`intensity-option ${intensity === item.value ? "intensity-option--active" : ""}`}
              onClick={() => setIntensity(item.value)}
            >
              {item.label}
            </View>
          ))}
        </View>
      </View>

      {errorMessage && <View className="error-card">{errorMessage}</View>}

      <Button
        className="generate-button"
        disabled={!canSubmit}
        loading={submitting}
        onClick={submit}
      >
        {submitting ? "正在理解原款并生成…" : "生成改款方案"}
      </Button>
      <Text className="privacy-note">原图仅用于本次生成，模型密钥不会发送到手机端</Text>

      {result && (
        <View className="result-section">
          <View className="result-heading">
            <Text className="result-kicker">DESIGN READY</Text>
            <Text className="result-title">你的改款方案</Text>
            <Text className="result-summary">{result.summary}</Text>
          </View>
          <Image className="result-image" src={result.resultUrl} mode="widthFix" />
          <View className="result-meta">
            <Text>{result.model}</Text>
            <Text>{Math.max(1, Math.round(result.durationMs / 1_000))} 秒</Text>
          </View>
        </View>
      )}
    </View>
  );
}
