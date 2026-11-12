import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { channels, type Hex } from "./colour";
import { HEX_TOKENS, type Tokens } from "./derive";

export function applyTokens(root: HTMLElement, t: Tokens): void {
  Object.entries(t)
    .filter(([k]) => k !== "scheme")
    .forEach(([k, v]) => root.style.setProperty(`--${k}`, v));
  HEX_TOKENS.forEach((k) => root.style.setProperty(`--${k}-rgb`, channels(t[k])));
  root.style.colorScheme = t.scheme;
  root.dataset.scheme = t.scheme;
}

export async function paintNative(ground: Hex): Promise<void> {
  await Promise.all([getCurrentWindow().setBackgroundColor(ground), getCurrentWebview().setBackgroundColor(ground)]);
}
