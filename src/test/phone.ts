import { vi } from "vitest";
import type { Clock } from "../services/clock";
import type { HolidayService } from "../services/holidays";
import { Registry } from "../store/registry";
import type { PlanSession } from "../store/session";
import { IPHONE, setPlatform } from "./platform";
import { offeredSettings, tauri } from "./tauriMock";

export async function phoneRegistry(t: { session: PlanSession; clock: Clock }, opts?: { holidays?: HolidayService }): Promise<Registry> {
  if (tauri.answers.device_info === undefined) {
    tauri.answers.device_info = () => ({ deviceId: "mac", platform: "ios" });
    setPlatform(IPHONE);
  }
  tauri.answers.settings_read ??= offeredSettings;
  tauri.answers.settings_write ??= () => null;
  const registry = await Registry.open({ clock: t.clock, holidays: opts?.holidays });
  const view = t.session.view();
  vi.spyOn(registry, "plans").mockReturnValue([{ id: view.plan.id, name: view.plan.name, trashed: false, loaded: true, space: null, example: false }]);
  vi.spyOn(registry, "session").mockResolvedValue(t.session);
  return registry;
}
