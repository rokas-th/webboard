import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Refused } from "../../actions/intents";
import type { PlanId } from "../../domain/model";
import { AppError } from "../../services/ipc";
import type { PlanListing, Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { toast } from "../common/Toast";
import { pickPlan, useUiValue } from "../state";
import { importFlow } from "./fileFlows";

export type PlanMain =
  | { k: "empty" }
  | { k: "opening"; id: PlanId }
  | { k: "open"; id: PlanId; session: PlanSession }
  | { k: "incomplete"; id: PlanId; message: string }
  | { k: "failed"; id: PlanId; error: AppError };

export interface PlanSelection {
  main: PlanMain;
  open(id: PlanId): void;
  trashOwn(id: PlanId): Promise<void>;
}

export const quoted = (l: PlanListing | undefined): string => (l === undefined || l.name === null ? "the plan" : `“${l.name}”`);

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
  const mainRef = useRef<PlanMain>(main);
  const unrecorded = useRef(false);
  const ownTrash = useRef(new Set<PlanId>());
  const lastTrashed = useRef(new Map<PlanId, boolean>());

  const setMain = useCallback((m: PlanMain) => {
    mainRef.current = m;
    setMainState(m);
  }, []);

  const select = useCallback(
    (id: PlanId | null) => {
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
          const recorded = e instanceof AppError && registry.failures().get(id) === e;
          const incomplete = e instanceof AppError && e.code === "plan.incomplete";
          if (!recorded && !incomplete) {
            if (selected.current === id) {
              unrecorded.current = true;
              setMain({ k: "failed", id, error: e instanceof AppError ? e : new AppError("plan.open", messageOf(e)) });
            }
            throw e;
          }
          if (selected.current !== id) return;
          if (incomplete) {
            setMain({ k: "incomplete", id, message: e.message });
            return;
          }
          unrecorded.current = false;
          setMain({ k: "failed", id, error: e });
        },
      );
    },
    [registry, setMain],
  );

  useEffect(() => {
    const takeIndexRepair = (): void => {
      const notice = registry.takeIndexRepairNotice();
      if (notice !== null) toast(notice);
    };
    const remember = (plans: readonly PlanListing[]): void => {
      lastTrashed.current = new Map(plans.map((l) => [l.id, l.trashed]));
    };
    const reselect = (plans: readonly PlanListing[]): boolean => {
      const next = pickPlan(plans, selected.current);
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
        if (m.k === "failed" && m.id === current && !unrecorded.current && !registry.failures().has(current)) load(current);
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
      if (m.k === "failed" && m.id === id) load(id);
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

export interface PlanFiles {
  creating: boolean;
  importing: boolean;
  newPlan(): void;
  importPlan(): void;
}

export function usePlanFiles(registry: Registry, open: (id: PlanId) => void): PlanFiles {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const creatingRef = useRef(false);
  const newPlan = (): void => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    registry
      .createPlan("New plan")
      .then(
        (id) => open(id),
        (e: unknown) => toast(surfaced(e), "bad"),
      )
      .finally(() => {
        creatingRef.current = false;
        setCreating(false);
      });
  };
  const importPlan = (): void => {
    setImporting(true);
    void importFlow(registry, (id) => open(id)).finally(() => setImporting(false));
  };
  return { creating, importing, newPlan, importPlan };
}
