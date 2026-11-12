import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/timeline.css";
import "./styles/board.css";
import "./styles/list.css";
import "./styles/panel.css";
import "./styles/calendar.css";
import "./styles/choices.css";
import "./styles/palette.css";
import "./styles/sync.css";
import "./styles/sheet.css";
import "./styles/theme.css";
import "./styles/phone.css";
import "./styles/print.css";
import App from "./App";
import { RootBoundary } from "./ui/shell/RootBoundary";
import { applyTokens } from "./theme/apply";
import { tokensOf } from "./theme/presets";
import { loadStore, shownTheme } from "./theme/store";
import { ThemeProvider } from "./theme/ThemeContext";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

const boot = loadStore(window.localStorage);
applyTokens(document.documentElement, tokensOf(shownTheme(boot.store, window.matchMedia("(prefers-color-scheme: dark)").matches)));

if (import.meta.env.VITE_WEBBOARD_PROBE === "1") {
  import("./probe/ProbeApp")
    .then(({ default: ProbeApp }) => ReactDOM.createRoot(root).render(<ProbeApp />))
    .catch((e: unknown) => {
      root.textContent = `The probe did not load: ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    });
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RootBoundary reload={() => window.location.reload()}>
        <ThemeProvider storage={window.localStorage} initial={boot}>
          <App />
        </ThemeProvider>
      </RootBoundary>
    </React.StrictMode>,
  );
}
