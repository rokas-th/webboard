import { flushSync } from "react-dom";
import { AppError } from "../../services/ipc";
import type { DeviceInfo } from "../../store/registry";
import { toast } from "../common/Toast";
import { printNow } from "./print";

export async function startPrint(platform: DeviceInfo["platform"], setPrinting: (on: boolean) => void): Promise<void> {
  flushSync(() => setPrinting(true));
  try {
    await printNow(platform);
  } catch (e) {
    setPrinting(false);
    if (!(e instanceof AppError)) throw e;
    toast(e.message, "bad");
  }
}
