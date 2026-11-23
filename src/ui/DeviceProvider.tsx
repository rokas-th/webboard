import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { dayOrderOf, type DateStyle } from "../domain/dates";
import type { PersonId, PlanId } from "../domain/model";
import { readPlatform } from "../platform";
import { lookOf, meFor, saveDevice, type DevicePrefs, type Look } from "./device";

export type DevicePatch = Partial<Omit<DevicePrefs, "v" | "me">>;

export interface DeviceApi {
  prefs: DevicePrefs;
  set(patch: DevicePatch): void;
  setMe(plan: PlanId, person: PersonId | null): void;
}

const DeviceContext = createContext<DeviceApi | null>(null);

const StyleContext = createContext<DateStyle | null>(null);

export function DeviceProvider(p: { storage: Storage; locale: string; initial: DevicePrefs; children: ReactNode }) {
  const { storage } = p;
  const [prefs, setPrefs] = useState<DevicePrefs>(p.initial);
  const current = useRef<DevicePrefs>(p.initial);
  const order = useMemo(() => dayOrderOf(p.locale), [p.locale]);

  const commit = useCallback(
    (next: DevicePrefs): void => {
      saveDevice(storage, next);
      current.current = next;
      setPrefs(next);
    },
    [storage],
  );

  const api = useMemo<DeviceApi>(
    () => ({
      prefs,
      set: (patch) => commit({ ...current.current, ...patch }),
      setMe: (plan, person) => {
        const rest = Object.entries(current.current.me).filter(([id]) => id !== plan);
        commit({ ...current.current, me: Object.fromEntries(person === null ? rest : [...rest, [plan, person]]) });
      },
    }),
    [prefs, commit],
  );

  const style = useMemo<DateStyle>(() => ({ format: prefs.dates, order }), [prefs.dates, order]);

  return (
    <DeviceContext.Provider value={api}>
      <StyleContext.Provider value={style}>{p.children}</StyleContext.Provider>
    </DeviceContext.Provider>
  );
}

export function useDevice(): DeviceApi {
  const api = useContext(DeviceContext);
  if (api === null) throw new Error("useDevice needs a DeviceProvider");
  return api;
}

export function useLook(): Look {
  const { prefs } = useDevice();
  return lookOf(prefs, readPlatform(window));
}

export function useMe(plan: PlanId): PersonId | null {
  const { prefs } = useDevice();
  return meFor(prefs, plan);
}

export function useDateStyle(): DateStyle {
  const style = useContext(StyleContext);
  if (style === null) throw new Error("useDateStyle needs a DeviceProvider");
  return style;
}
