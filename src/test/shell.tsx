import type { ReactElement } from "react";
import type { RegionRef } from "../domain/calendar";
import type { PlanId } from "../domain/model";
import { fixedClock, notifyEach } from "../services/clock";
import { AppError } from "../services/ipc";
import { Registry } from "../store/registry";
import { Shell } from "../ui/shell/Shell";
import { memoryStore, type MemoryStore } from "./fixtures/store";
import { TEST_DEVICES, type TestSession } from "./session";
import { offeredSettings, resetTauri, type Answer, type Call } from "./tauriMock";

export type TestRegistry = Registry & { notify(): void };

const STUBBED = [
  "createPlan",
  "createPlanFrom",
  "trashPlan",
  "restorePlan",
  "setLastRegion",
  "warm",
  "reloadFromServer",
  "retryIndex",
  "retrySettings",
  "attachSpace",
  "movePlanToSpace",
  "nameThisDevice",
  "syncedHeads",
  "setSyncedHeads",
  "setSpaceReadOnly",
] as const;

export function testRegistry(t: TestSession, over: Partial<Registry> = {}): TestRegistry {
  const id: PlanId = t.session.view().plan.id;
  const listeners = new Set<() => void>();
  const failures = new Map<PlanId, AppError>();
  const notify = (): void => notifyEach(listeners);
  t.doc.onError((e) => {
    failures.set(id, e);
    notify();
  });
  const unknown = (x: string): Error => new Error("testRegistry: no plan " + x);
  const stubs = Object.fromEntries(
    STUBBED.map((name) => [
      name,
      () => {
        throw new Error(`testRegistry: Registry.${name} is not stubbed`);
      },
    ]),
  );
  const base = {
    ...stubs,
    device: { deviceId: "mac", name: "Mac", platform: "macos" },
    holidays: t.holidays,
    plans: () => [{ id, name: t.session.view().plan.name, trashed: false, loaded: true, space: null }],
    session: (x: string) => (x === id ? Promise.resolve(t.session) : Promise.reject(unknown(x))),
    doc: (x: string) => (x === id ? Promise.resolve(t.doc) : Promise.reject(unknown(x))),
    failures: () => failures,
    retryPlan: async (x: string) => {
      try {
        await t.doc.retry();
        failures.delete(x);
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        failures.set(x, e);
      }
      notify();
    },
    devices: () => TEST_DEVICES,
    openSessions: () => [t.session],
    indexError: () => null,
    indexErrorDoc: () => null,
    settingsError: () => null,
    takeIndexRepairNotice: () => null,
    indexUnreadable: () => [],
    localSpaces: () => [],
    spaceReadOnly: () => false,
    reloading: () => false,
    attachedSpace: () => null,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    notify,
  };
  return { ...base, ...over, notify } as unknown as TestRegistry;
}

export function shellFor(t: TestSession, over?: Partial<Registry>): { ui: ReactElement; registry: TestRegistry } {
  const registry = testRegistry(t, over);
  return { ui: <Shell registry={registry} clock={t.clock} />, registry };
}

export interface SeededStore {
  mem: MemoryStore;
  state: { settings: unknown };
  answers: Record<string, Answer>;
  ids: PlanId[];
}

const yearArg = (args: Call["args"]): number => {
  const year = args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args.year : undefined;
  if (typeof year !== "number") throw new Error("holidays_year without a year");
  return year;
};

export const emptyYear: Answer = (args) => {
  yearArg(args);
  return { days: [], fetchedAt: "2026-11-09T08:00:00Z", fromCache: false, coverage: [2020, 2030] };
};

export async function seededStore(names: readonly string[], o: { trash?: readonly number[]; lastRegion?: RegionRef } = {}): Promise<SeededStore> {
  const mem = memoryStore();
  const state: { settings: unknown } = { settings: offeredSettings() };
  const answers: Record<string, Answer> = {
    ...mem.answers,
    settings_read: () => state.settings,
    settings_write: (args) => {
      if (args === undefined || args instanceof Uint8Array || args instanceof ArrayBuffer || Array.isArray(args)) throw new Error("settings_write without settings");
      state.settings = args.settings;
      return null;
    },
    device_info: () => ({ deviceId: "mac", platform: "macos" }),
    holidays_year: emptyYear,
  };
  resetTauri(answers);
  const r = await Registry.open({ clock: fixedClock("2026-11-09") });
  const ids: PlanId[] = [];
  for (const n of names) ids.push(await r.createPlan(n));
  (o.trash ?? []).forEach((i) => r.trashPlan(ids[i]));
  await new Promise<void>((res) => setTimeout(res, 0));
  await r.close();
  await new Promise<void>((res) => setTimeout(res, 0));
  if (o.lastRegion !== undefined) {
    const s = state.settings;
    state.settings = typeof s === "object" && s !== null ? { ...s, lastRegion: o.lastRegion } : { v: 1, lastRegion: o.lastRegion, names: {} };
  }
  resetTauri(answers);
  return { mem, state, answers, ids };
}
