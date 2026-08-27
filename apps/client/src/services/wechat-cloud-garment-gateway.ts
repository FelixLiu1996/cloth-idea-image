import { GenerationApiError, type GarmentGateway, type TrialCapabilities } from "./garment-gateway";

function cloudBackendNotDeployed(): GenerationApiError {
  return new GenerationApiError(
    "微信云端服务尚未部署，请暂时使用 H5 本地链路。",
    "CLOUD_BACKEND_NOT_DEPLOYED",
    false,
  );
}

export class WechatCloudGarmentGateway implements GarmentGateway {
  analyzeGarment(): Promise<never> {
    return Promise.reject(cloudBackendNotDeployed());
  }

  createGeneration(): Promise<never> {
    return Promise.reject(cloudBackendNotDeployed());
  }

  refineGeneration(): Promise<never> {
    return Promise.reject(cloudBackendNotDeployed());
  }

  getTrialCapabilities(): Promise<TrialCapabilities> {
    return Promise.reject(cloudBackendNotDeployed());
  }
}
