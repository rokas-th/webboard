import type { ReactElement } from "react";
import { loadStore } from "../theme/store";
import { ThemeProvider } from "../theme/ThemeContext";
import { loadDevice } from "../ui/device";
import { DeviceProvider } from "../ui/DeviceProvider";

export const TEST_LOCALE = "en-GB";

export function deviced(ui: ReactElement): ReactElement {
  return (
    <DeviceProvider storage={window.localStorage} locale={TEST_LOCALE} initial={loadDevice(window.localStorage)}>
      {ui}
    </DeviceProvider>
  );
}

export function themed(ui: ReactElement): ReactElement {
  return <ThemeProvider storage={window.localStorage} initial={loadStore(window.localStorage)}>{deviced(ui)}</ThemeProvider>;
}
