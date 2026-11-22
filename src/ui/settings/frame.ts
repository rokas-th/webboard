import type { Os } from "../../platform";
import type { PlanListMode } from "../shell/planListMode";

export type SettingsFrame = "modal" | "sheet";

export function settingsFrame(os: Os, listMode: PlanListMode): SettingsFrame {
  if (listMode === "phone") return "sheet";
  return os === "ios" && listMode === "sheet" ? "sheet" : "modal";
}
