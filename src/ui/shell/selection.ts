import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { normalizeName } from "../../actions/build";
import { Refused } from "../../actions/intents";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { toast } from "../common/Toast";
import { holdsNoPlan, pickPlan, releaseNoPlan, useUiValue } from "../state";
import { importFlow } from "./fileFlows";

export type PlanMain =
  | { k: "empty" }
  | { k: "opening"; id: PlanId }
  | { k: "open"; id: PlanId; session: PlanSession }
  | { k: "incomplete"; id: PlanId; message: string }
  | { k: "failed"; id: PlanId; error: AppError; recorded: boolean }
  | { k: "error"; id: PlanId; message: string };

export interface PlanSelection {
  main: PlanMain;
  open(id: PlanId): void;
  trashOwn(id: PlanId): Promise<void>;
}

export const quoted = (l: PlanListing | undefined): string => (l === undefined || l.name === null ? "the plan" : `“${l.name}”`);

export const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function surfaced(e: unknown): string {
  if (e instanceof AppError || e instanceof Refused) return e.message;
  throw e;
}

function takeRepair(s: PlanSession): void {
  const notice = s.takeRepairNotice();
  if (notice !== null) toast(notice);
}

export function usePlanSelection(registry: Registry): PlanSelection {
  const { ui, setUi } = useUiValue();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [main, setMainState] = useState<PlanMain>({ k: "empty" });
  const selected = useRef(ui.plan);
  const [heldAtStart] = useState(() => ui.plan === null && holdsNoPlan());
  const holding = useRef(heldAtStart);
  const mainRef = useRef<PlanMain>(main);
  const ownTrash = useRef(new Set<PlanId>());
  const lastTrashed = useRef(new Map<PlanId, boolean>());

  const setMain = useCallback((m: PlanMain) => {
    mainRef.current = m;
    setMainState(m);
  }, []);

  const select = useCallback(
    (id: PlanId | null) => {
      if (id !== null && holding.current) {
        holding.current = false;
        releaseNoPlan();
      }
      if (id === selected.current) {
        setUi({ plan: id });
        return;
      }
      selected.current = id;
      setUi({ plan: id, selected: null, dialog: null });
    },
    [setUi],
  );

  const load = useCallback(
    (id: PlanId) => {
      const m = mainRef.current;
      if (!(m.k === "incomplete" && m.id === id)) setMain({ k: "opening", id });
      registry.session(id).then(
        (s) => {
          if (selected.current !== id) return;
          setMain({ k: "open", id, session: s });
          takeRepair(s);
        },
        (e: unknown) => {
          if (!(e instanceof AppError)) {
            if (selected.current === id) setMain({ k: "error", id, message: messageOf(e) });
            throw e;
          }
          const incomplete = e.code === "plan.incomplete";
          const recorded = registry.failures().get(id) === e;
          if (selected.current === id) setMain(incomplete ? { k: "incomplete", id, message: e.message } : { k: "failed", id, error: e, recorded });
          if (!recorded && !incomplete) throw e;
        },
      );
    },
    [registry, setMain],
  );

  useEffect(() => {
    const takeIndexRepair = (): void => {
      const notice = registry.takeIndexRepairNotice();
      if (notice !== null) toast(notice);
      registry.takeGoneNotices().forEach((n) => toast(n.text, n.bad ? "bad" : undefined));
    };
    const remember = (plans: readonly PlanListing[]): void => {
      lastTrashed.current = new Map(plans.map((l) => [l.id, l.trashed]));
    };
    const reselect = (plans: readonly PlanListing[]): boolean => {
      const next = holding.current && selected.current === null ? null : pickPlan(plans, selected.current);
      if (next === selected.current) return false;
      select(next);
      return true;
    };
    const onNotify = (): void => {
      bump();
      const plans = registry.plans();
      const current = selected.current;
      const listing = plans.find((l) => l.id === current);
      if (current !== null && listing !== undefined && listing.trashed && lastTrashed.current.get(current) === false && !ownTrash.current.has(current)) {
        toast(`${capital(quoted(listing))} was moved to the Trash on another device. Restore it from the Trash.`);
      }
      remember(plans);
      if (!reselect(plans) && current !== null) {
        const m = mainRef.current;
        if (m.k === "incomplete" && m.id === current) load(current);
        if (m.k === "failed" && m.id === current && m.recorded && !registry.failures().has(current)) load(current);
      }
      takeIndexRepair();
    };
    const plans = registry.plans();
    remember(plans);
    reselect(plans);
    takeIndexRepair();
    return registry.subscribe(onNotify);
  }, [registry, select, load]);

  useEffect(() => {
    if (ui.plan === null) {
      setMain({ k: "empty" });
      return;
    }
    if (pickPlan(registry.plans(), ui.plan) !== ui.plan) return;
    selected.current = ui.plan;
    load(ui.plan);
  }, [ui.plan, registry, load, setMain]);

  const session = main.k === "open" ? main.session : null;

  useEffect(() => {
    if (session === null) return;
    return session.subscribe(() => takeRepair(session));
  }, [session]);

  const open = useCallback(
    (id: PlanId) => {
      if (id !== selected.current) {
        select(id);
        return;
      }
      setUi({ plan: id });
      const m = mainRef.current;
      if ((m.k === "failed" || m.k === "error") && m.id === id) load(id);
    },
    [select, load, setUi],
  );

  const trashOwn = useCallback(
    async (id: PlanId): Promise<void> => {
      const listing = registry.plans().find((l) => l.id === id);
      ownTrash.current.add(id);
      try {
        registry.trashPlan(id);
      } catch (e) {
        toast(surfaced(e), "bad");
        return;
      } finally {
        ownTrash.current.delete(id);
      }
      toast(`Moved ${quoted(listing)} to the Trash. Restore it from the Trash.`);
    },
    [registry],
  );

  return { main, open, trashOwn };
}

export function restorePlan(registry: Registry, id: PlanId): void {
  const listing = registry.plans().find((l) => l.id === id);
  try {
    registry.restorePlan(id);
  } catch (e) {
    toast(surfaced(e), "bad");
    return;
  }
  toast(`Restored ${quoted(listing)} from the Trash.`);
}

export interface PlanFiles {
  creating: boolean;
  importing: boolean;
  newPlan(raw: string, fail: (message: string) => void, made?: (id: PlanId) => void): void;
  newExample(fail: (message: string) => void): void;
  importPlan(): void;
}

export function usePlanFiles(registry: Registry, open: (id: PlanId) => void): PlanFiles {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const creatingRef = useRef(false);
  const importingRef = useRef(false);
  const create = (make: () => Promise<PlanId>, fail: (message: string) => void, made?: (id: PlanId) => void): void => {
    creatingRef.current = true;
    setCreating(true);
    make()
      .then(
        (id) => {
          open(id);
          made?.(id);
        },
        (e: unknown) => fail(surfaced(e)),
      )
      .finally(() => {
        creatingRef.current = false;
        setCreating(false);
      });
  };
  const newPlan = (raw: string, fail: (message: string) => void, made?: (id: PlanId) => void): void => {
    if (creatingRef.current) return;
    let name: string;
    try {
      name = normalizeName(raw);
    } catch (e) {
      fail(surfaced(e));
      return;
    }
    create(() => registry.createPlan(name), fail, made);
  };
  const newExample = (fail: (message: string) => void): void => {
    if (creatingRef.current) return;
    create(() => registry.createExample(), fail);
  };
  const importPlan = (): void => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    void importFlow(registry, (id) => open(id)).finally(() => {
      importingRef.current = false;
      setImporting(false);
    });
  };
  return { creating, importing, newPlan, newExample, importPlan };
}
