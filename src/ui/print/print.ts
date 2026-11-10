import { call } from "../../services/ipc";
import type { DeviceInfo } from "../../store/registry";

export async function printNow(platform: DeviceInfo["platform"]): Promise<void> {
  switch (platform) {
    case "macos":
      await call<null>("print_window");
      return;
    case "linux":
      window.print();
      return;
    case "ios":
      throw new Error("Print is not offered on iOS");
  }
}
