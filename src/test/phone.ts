import { vi } from "vitest";
import type { Clock } from "../services/clock";
import type { HolidayService } from "../services/holidays";
import type { PersistedDoc } from "../store/persist";
import { Registry } from "../store/registry";
import type { PlanSession } from "../store/session";
import { tauri } from "./tauriMock";

export async function phoneRegistry(t: { session: PlanSession; clock: Clock; holidays?: HolidayService; doc?: PersistedDoc }): Promise<Registry> {
  tauri.answers.device_info ??= () => ({ deviceId: "mac", platform: "ios" });
  tauri.answers.settings_read ??= () => null;
  tauri.answers.settings_write ??= () => null;
  const registry = await Registry.open({ clock: t.clock });
  const view = t.session.view();
  const id = view.plan.id;
  vi.spyOn(registry, "plans").mockReturnValue([{ id, name: view.plan.name, trashed: false, loaded: true, space: null }]);
  vi.spyOn(registry, "session").mockResolvedValue(t.session);
  if (t.holidays !== undefined) Object.defineProperty(registry, "holidays", { value: t.holidays });
  const doc = t.doc;
  if (doc !== undefined) {
    const real = registry.doc.bind(registry);
    vi.spyOn(registry, "doc").mockImplementation((x) => (x === id ? Promise.resolve(doc) : real(x)));
  }
  return registry;
}
