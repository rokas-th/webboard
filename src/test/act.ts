import type { Action, ActionId, DeviceId, SessionId, Write } from "../log/types";

export function act(
  id: ActionId,
  par: readonly ActionId[],
  w: readonly Write[],
  o: { dev?: DeviceId; ses?: SessionId; at?: number; lbl?: string; meta?: Action["meta"] } = {},
): Action {
  const dev = o.dev ?? "d1";
  return {
    id,
    dev,
    ses: o.ses ?? "s-" + dev,
    at: o.at ?? 0,
    par,
    lbl: o.lbl ?? id,
    w,
    ...(o.meta === undefined ? {} : { meta: o.meta }),
  };
}
