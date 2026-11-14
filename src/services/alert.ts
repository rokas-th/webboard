import { readPlatform } from "../platform";
import { AppError, answerOf, call } from "./ipc";

export interface NativeAsk {
  title: string;
  message: string;
  confirm: { label: string; destructive: boolean } | null;
  cancel: string;
}

export type NativeAnswer = "confirm" | "cancel";

export const CANCEL_LABEL = "Cancel";

export const usesNativeAlert = (): boolean => readPlatform(window).os === "ios";

export async function askNative(ask: NativeAsk): Promise<NativeAnswer> {
  const { os } = readPlatform(window);
  if (os !== "ios") throw new AppError("alert.platform", `A native alert was asked for on ${os}, where only iOS has one`);
  const answer = await call<unknown>("alert_ask", { ask });
  if (answer === "confirm" || answer === "cancel") return answer;
  throw new AppError("ipc.shape", `alert_ask answered ${answerOf(answer)} instead of "confirm" or "cancel"`);
}
