export type ActionId = string;
export type DeviceId = string;
export type SessionId = string;
export type UnitKey = string;
export type Cause = "own" | "push" | "recalendar" | "undo" | "revert" | "resolution";

export const OWNER_CAUSES: ReadonlySet<Cause> = new Set<Cause>(["own", "undo", "revert", "resolution"]);

export interface Write {
  u: UnitKey;
  v: unknown;
  c: Cause;
}

export interface Action {
  id: ActionId;
  dev: DeviceId;
  ses: SessionId;
  at: number;
  par: readonly ActionId[];
  lbl: string;
  w: readonly Write[];
  meta?: { undo?: ActionId; redo?: ActionId; revert?: ActionId; resolves?: string; imported?: string };
}

export interface Rules {
  same(u: UnitKey, a: unknown, b: unknown): boolean;
  mergeDerived(u: UnitKey, a: Write, b: Write): Write;
}

export interface UnitState {
  value: unknown;
  from: ActionId;
  clash: readonly ActionId[] | null;
}

export interface LogDelta {
  units: ReadonlySet<UnitKey>;
  activity: ReadonlySet<ActionId>;
  added: readonly ActionId[];
}
