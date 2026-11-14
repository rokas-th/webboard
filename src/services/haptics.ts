import { readPlatform } from "../platform";
import { detailsOf } from "../ui/common/errorText";
import { toastWithoutHaptic } from "../ui/common/Toast";
import { AppError, callNull } from "./ipc";

export type HapticKind = "selection" | "light" | "medium" | "success" | "warning" | "error";

export const HAPTICS_OFF = " Haptics are off until WebBoard restarts.";

export async function sendHaptic(kind: HapticKind): Promise<void> {
  const { os } = readPlatform(window);
  if (os !== "ios") throw new AppError("haptic.platform", `The ${kind} haptic was asked for on ${os}, where only iOS plays one`);
  await callNull("haptic", { kind });
}

const faults = new Set<unknown>();

let off = false;

export const takeHapticFault = (e: unknown): boolean => faults.delete(e);

export const resetHaptics = (): void => {
  off = false;
  faults.clear();
};

export async function playHaptic(kind: HapticKind): Promise<void> {
  try {
    await sendHaptic(kind);
  } catch (e) {
    if (!(e instanceof AppError)) {
      faults.add(e);
      throw e;
    }
    console.error(e);
    if (off) return;
    off = true;
    toastWithoutHaptic(`${e.message}${HAPTICS_OFF}`, "bad", `${e.code}\n${detailsOf(e)}`);
  }
}

export function haptic(kind: HapticKind): void {
  if (readPlatform(window).os !== "ios" || off) return;
  void playHaptic(kind);
}
