import type { PropsWithChildren } from "react";

import { initializeConfiguredWechatCloud } from "./platform/wechat-cloud-platform";
import "./app.scss";

initializeConfiguredWechatCloud();

function App({ children }: PropsWithChildren<Record<string, never>>) {
  return children;
}

export default App;
