import { useCallback, useEffect, useRef, useState } from "react";
import { Refused, type Built } from "../../actions/intents";
import type { Pick, ResolveOptions } from "../../actions/resolve";
import type { PlanState } from "../../domain/model";
import type { UnitKey } from "../../log/types";
import type { Choice } from "../../plan/choices";
import { toast } from "../common/Toast";
import { unitSubject } from "./describe";

export const SETTLED = "This choice was settled meanwhile.";
export const CHOICE_TITLE = "Choose which to keep";

export const DEFAULTS: ResolveOptions = { pushFromPredecessors: true, returnPushed: true };

export type Picks = ReadonlyMap<UnitKey, string>;

const NO_DROPS: readonly string[] = [];

export const droppedPickText = (subject: string): string => `Your pick for ${subject} no longer applies.`;

export const pickOf = (side: string, perUnit: Picks): Pick => (perUnit.size === 0 ? { side } : { side, perUnit });

export const livePicks = (choice: Choice, perUnit: Picks, plan: PlanState): { live: Picks; dropped: readonly string[] } => {
  const applies = ([u, side]: [UnitKey, string]): boolean => choice.units.includes(u) && choice.sides.some((s) => s.key === side && s.values.has(u));
  const live = [...perUnit].filter(applies);
  if (live.length === perUnit.size) return { live: perUnit, dropped: NO_DROPS };
  return { live: new Map(live), dropped: [...perUnit].filter((e) => !applies(e)).map(([u]) => unitSubject(u, plan)) };
};

export function usePicks(choice: Choice, plan: PlanState): [Picks, (next: Picks) => void] {
  const [picks, setPicks] = useState<Picks>(() => new Map());
  const { live, dropped } = livePicks(choice, picks, plan);
  useEffect(() => {
    if (dropped.length === 0) return;
    dropped.forEach((subject) => toast(droppedPickText(subject)));
    setPicks(live);
  }, [dropped, live]);
  return [live, setPicks];
}

export function useSettledClose(gone: boolean, onClose: () => void): (write: () => Built) => () => Built {
  const told = useRef(false);
  const closed = useRef(false);
  useEffect(() => {
    if (!gone || closed.current) return;
    closed.current = true;
    if (!told.current) toast(SETTLED);
    onClose();
  }, [gone, onClose]);
  return useCallback(
    (write: () => Built) => (): Built => {
      try {
        return write();
      } catch (e) {
        if (e instanceof Refused && e.message === SETTLED) told.current = true;
        throw e;
      }
    },
    [],
  );
}
