import { httpGarmentGateway } from "./generation-api";
import type { GarmentGateway } from "./garment-gateway";
import { WechatCloudGarmentGateway } from "./wechat-cloud-garment-gateway";

export type GarmentGatewayMode = "http" | "wechat-cloud";

export function createGarmentGateway(mode: string): GarmentGateway {
  if (mode === "http") {
    return httpGarmentGateway;
  }
  if (mode === "wechat-cloud") {
    return new WechatCloudGarmentGateway();
  }
  throw new Error(`Unsupported garment gateway mode: ${mode}`);
}

const configuredGatewayMode =
  typeof GARMENT_GATEWAY_MODE === "undefined" ? "http" : GARMENT_GATEWAY_MODE;

export const garmentGateway = createGarmentGateway(configuredGatewayMode);
