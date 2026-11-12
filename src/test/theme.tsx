import type { ReactElement } from "react";
import { loadStore } from "../theme/store";
import { ThemeProvider } from "../theme/ThemeContext";

export function themed(ui: ReactElement): ReactElement {
  return (
    <ThemeProvider storage={window.localStorage} initial={loadStore(window.localStorage)}>
      {ui}
    </ThemeProvider>
  );
}
