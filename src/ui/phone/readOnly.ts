import { useCallback, useSyncExternalStore } from "react";
import type { PlanSession } from "../../store/session";

export function useReadOnly(session: PlanSession): boolean {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  return useSyncExternalStore(subscribe, () => session.readOnly);
}
