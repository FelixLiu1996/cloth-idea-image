import type { PropsWithChildren } from "react";

import "./app.scss";

function App({ children }: PropsWithChildren<Record<string, never>>) {
  return children;
}

export default App;
