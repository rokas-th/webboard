import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Registry } from "../store/registry";
import { SyncManager, type SyncState } from "./manager";
import { yProviderFactory, type ProviderFactory } from "./provider";

interface SyncValue {
  manager: SyncManager;
  registry: Registry;
}

const SyncContext = createContext<SyncValue | null>(null);

const running = new WeakMap<Registry, SyncManager | "not started">();

const onlineChange = (cb: () => void): (() => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};

export function docName(registry: Registry): (doc: string) => string | null {
  return (doc) => registry.plans().find((p) => p.id === doc)?.name ?? null;
}

export function syncPending(registry: Registry): void {
  if (running.has(registry)) throw new Error("syncPending: sync is already recorded for this registry");
  running.set(registry, "not started");
}

export function stopSync(registry: Registry): void {
  const manager = running.get(registry);
  if (manager === undefined) throw new Error("stopSync: no SyncManager runs for this registry");
  if (manager === "not started") return;
  manager.stop();
}

export function SyncProvider(props: { registry: Registry; factory?: ProviderFactory; children: ReactNode }) {
  const { registry } = props;
  const factory = props.factory ?? yProviderFactory;
  const manager = useMemo(
    () =>
      new SyncManager({
        factory,
        registry,
        sessions: () => registry.openSessions(),
        online: () => navigator.onLine,
        onlineChange,
        now: Date.now,
      }),
    [registry, factory],
  );
  useEffect(() => {
    running.set(registry, manager);
    void manager.start();
    return () => {
      manager.stop();
      if (running.get(registry) === manager) running.set(registry, "not started");
    };
  }, [registry, manager]);
  const value = useMemo(() => ({ manager, registry }), [manager, registry]);
  return <SyncContext.Provider value={value}>{props.children}</SyncContext.Provider>;
}

function useSyncValue(): SyncValue {
  const value = useContext(SyncContext);
  if (value === null) throw new Error("useSyncState needs a SyncProvider.");
  return value;
}

export function useSyncState(): { state: SyncState; manager: SyncManager; restart(): Promise<void> } {
  const { manager } = useSyncValue();
  const subscribe = useCallback((cb: () => void) => manager.subscribe(cb), [manager]);
  const snapshot = useCallback(() => manager.state(), [manager]);
  const state = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => ({ state, manager, restart: () => manager.restart() }), [state, manager]);
}

export function useSyncRegistry(): Registry {
  return useSyncValue().registry;
}
