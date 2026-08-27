import { Button, Image, Text, View } from "@tarojs/components";
import { useEffect, useState } from "react";

import { selectGarmentImage, type SelectedImage } from "../../platform/image-platform";
import {
  createWechatCloudInfrastructureProbe,
  deleteWechatCloudInfrastructureProbe,
  getWechatCloudInfrastructureCapabilities,
  getWechatCloudInfrastructureProbe,
} from "../../services/wechat-cloud-infrastructure";
import type { WechatCloudCapabilities, WechatCloudInfrastructureProbe } from "@cloth-idea/domain";
import "./index.scss";

export default function CloudDiagnostics() {
  const [capabilities, setCapabilities] = useState<WechatCloudCapabilities | null>(null);
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [probe, setProbe] = useState<WechatCloudInfrastructureProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function refreshCapabilities() {
    setBusy(true);
    setErrorMessage("");
    try {
      setCapabilities(await getWechatCloudInfrastructureCapabilities());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "读取云环境失败。");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    void getWechatCloudInfrastructureCapabilities()
      .then((nextCapabilities) => {
        if (active) {
          setCapabilities(nextCapabilities);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : "读取云环境失败。");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function chooseImage() {
    const selected = await selectGarmentImage();
    if (selected) {
      setImage(selected);
      setProbe(null);
      setErrorMessage("");
    }
  }

  async function runProbe() {
    if (!image || !capabilities?.authorized || busy) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      setProbe(await createWechatCloudInfrastructureProbe(image));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "云端探针执行失败。");
    } finally {
      setBusy(false);
    }
  }

  async function reloadProbe() {
    if (!probe || busy) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      setProbe(await getWechatCloudInfrastructureProbe(probe.probeId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "探针恢复失败。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProbe() {
    if (!probe || busy) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      await deleteWechatCloudInfrastructureProbe(probe.probeId);
      setProbe(null);
      setImage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "探针清理失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="diagnostics-page">
      <Text className="diagnostics-title">微信云开发诊断</Text>
      <Text className="diagnostics-copy">
        本页只验证 OpenID、云存储、云函数、数据库和任务恢复，不调用任何付费模型。
      </Text>

      <View className="diagnostics-card">
        <Text className="diagnostics-label">当前用户指纹</Text>
        <Text className="diagnostics-value">{capabilities?.viewerFingerprint ?? "正在读取…"}</Text>
        <Text className="diagnostics-label">体验权限</Text>
        <Text className="diagnostics-value">
          {capabilities?.authorized ? "已授权" : "尚未加入 trial_members"}
        </Text>
        <Button className="diagnostics-button" disabled={busy} onClick={refreshCapabilities}>
          刷新云端身份
        </Button>
      </View>

      <View className="diagnostics-card">
        <Text className="diagnostics-label">诊断图片</Text>
        {image && <Image className="diagnostics-image" src={image.path} mode="aspectFit" />}
        <Button className="diagnostics-button" disabled={busy} onClick={chooseImage}>
          选择一张测试图片
        </Button>
        <Button
          className="diagnostics-button"
          disabled={busy || !image || !capabilities?.authorized}
          onClick={runProbe}
        >
          运行无模型费用探针
        </Button>
      </View>

      {probe && (
        <View className="diagnostics-card">
          <Text className="diagnostics-label">探针状态</Text>
          <Text className="diagnostics-value">{probe.status}</Text>
          <Text className="diagnostics-label">探针任务 ID</Text>
          <Text className="diagnostics-value">{probe.probeId}</Text>
          <Button className="diagnostics-button" disabled={busy} onClick={reloadProbe}>
            从数据库重新读取
          </Button>
          <Button
            className="diagnostics-button diagnostics-button--danger"
            disabled={busy}
            onClick={deleteProbe}
          >
            删除云文件和探针记录
          </Button>
        </View>
      )}

      {errorMessage && <Text className="diagnostics-error">{errorMessage}</Text>}
    </View>
  );
}
