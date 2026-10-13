import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router-dom";
import {App} from "./App";
import {loadFrontendConfig} from "./config";
import "./styles.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import {SessionProvider} from "./wallet/session-store";

const root = createRoot(document.getElementById("root")!);
try {
  const config = loadFrontendConfig(import.meta.env);
  root.render(<StrictMode><BrowserRouter><SessionProvider><App apiOrigin={config.VITE_API_ORIGIN}
                                                               walletsEnabled={config.VITE_WALLETS_ENABLED === "true"}/></SessionProvider></BrowserRouter></StrictMode>);
} catch {
  root.render(<main className="configuration-error"><h1>PayUnlock is unavailable</h1><p>The application configuration
    needs attention. Please try again later.</p></main>);
}
