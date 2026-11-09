import { createContext, useContext, useMemo } from "react";
import { HeldRefused, Refused, type Built, type Intent } from "../actions/intents";
import { OfferRefused } from "../actions/undo";
import type { PlanSession } from "../store/session";
import { requestUndo } from "./choices/undo";
import { toast } from "./common/Toast";

export const READ_ONLY = "This device was removed from the space; its plans are read-only.";

export type OpenChoiceFn = (choice: string, side?: string) => void;

export const OpenChoice = createContext<OpenChoiceFn | null>(null);

export interface Run {
  run(i: Intent): Built | null;
  undo(): Built | null;
  redo(): Built | null;
}

type Exec = (write: () => Built | null) => Built | null;

const execWith =
  (session: PlanSession, open: OpenChoiceFn): Exec =>
  (write) => {
    if (session.readOnly) {
      toast(READ_ONLY, "bad");
      return null;
    }
    let built: Built | null;
    try {
      built = write();
    } catch (e) {
      if (e instanceof HeldRefused) {
        open(e.choice);
        return null;
      }
      if (e instanceof OfferRefused) {
        open(e.offer.choice, e.offer.side);
        return null;
      }
      if (e instanceof Refused) {
        toast(e.message, "bad");
        return null;
      }
      throw e;
    }
    if (built !== null) toast(built.toast);
    return built;
  };

function useOpenChoice(): OpenChoiceFn {
  const open = useContext(OpenChoice);
  if (open === null) throw new Error("useRun needs an OpenChoice provider");
  return open;
}

export function useExec(session: PlanSession): Exec {
  const open = useOpenChoice();
  return useMemo(() => execWith(session, open), [session, open]);
}

export function runWith(session: PlanSession, open: OpenChoiceFn): Run {
  const exec = execWith(session, open);
  return {
    run: (i: Intent) => exec(() => session.apply(i)),
    undo: () => exec(() => requestUndo(session, (o) => open(o.choice, o.side))),
    redo: () => exec(() => session.redo()),
  };
}

export function useRun(session: PlanSession): Run {
  const open = useOpenChoice();
  return useMemo(() => runWith(session, open), [session, open]);
}
