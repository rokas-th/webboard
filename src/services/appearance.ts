import { readPlatform } from "../platform";
import type { NativeScheme } from "../theme/store";
import { AppError, callNull } from "./ipc";

export async function setNativeScheme(scheme: NativeScheme): Promise<void> {
  const { os } = readPlatform(window);
  if (os !== "ios") throw new AppError("appearance.platform", `The native appearance was set to ${scheme} on ${os}, where only iOS has one`);
  await callNull("appearance_set", { scheme });
}
