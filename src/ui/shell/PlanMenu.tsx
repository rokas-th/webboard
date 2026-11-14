import { useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";
import type { PlanId } from "../../domain/model";
import { usesNativeMenu, type NativeMenuSection } from "../../services/nativeMenu";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { MENU_LIST, moved, useNativeMenu } from "../common/menu";
import { exportFlow, importFlow } from "./fileFlows";

const mounted = (b: HTMLButtonElement | null, missing: string): HTMLButtonElement => {
  if (b === null) throw new Error(missing);
  return b;
};

type Props = {
  session: PlanSession;
  registry: Registry;
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpen(id: PlanId): void;
  onPrint?: () => void;
};

const PLAN_ROWS: readonly NativeMenuSection[] = [
  {
    title: null,
    rows: [
      { id: "export", title: "Export plan…", checked: false },
      { id: "import", title: "Import plan…", checked: false },
    ],
  },
];

function runRow(p: Props, id: string): void {
  if (id === "export") void exportFlow(p.session);
  else if (id === "import") void importFlow(p.registry, p.onOpen);
  else throw new Error(`PlanMenu: the native menu chose ${JSON.stringify(id)}, which is no row of the Plan menu`);
}

function NativePlanMenu(p: Props) {
  const menu = useNativeMenu("PlanMenu");
  const toggle = useRef<HTMLButtonElement>(null);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });
  const { open, onOpenChange } = p;
  const { open: shown, dismiss } = menu;
  const wasShown = useRef(false);
  useEffect(() => {
    if (wasShown.current && !shown) onOpenChange(false);
    wasShown.current = shown;
  }, [shown, onOpenChange]);
  useEffect(() => {
    if (!open && shown) dismiss();
  }, [open, shown, dismiss]);
  return (
    <div className="plan-menu">
      <button
        type="button"
        ref={toggle}
        className="button-small"
        aria-label="Plan menu"
        aria-haspopup="menu"
        aria-expanded={shown}
        onClick={() => {
          onOpenChange(true);
          try {
            menu.show(toggle.current, PLAN_ROWS, (id) => runRow(latest.current, id));
          } catch (e) {
            onOpenChange(false);
            throw e;
          }
        }}
      >
        ⋯
      </button>
    </div>
  );
}

function HtmlPlanMenu(p: Props) {
  const { open, onOpenChange } = p;
  const toggle = useRef<HTMLButtonElement>(null);
  const exportItem = useRef<HTMLButtonElement>(null);
  const importItem = useRef<HTMLButtonElement>(null);
  const printItem = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const items = (): HTMLButtonElement[] => [
    mounted(exportItem.current, "PlanMenu opened without its first item"),
    mounted(importItem.current, "PlanMenu opened without its Import item"),
    ...(p.onPrint === undefined ? [] : [mounted(printItem.current, "PlanMenu opened without its Print item")]),
  ];

  useEffect(() => {
    if (!open) return;
    mounted(exportItem.current, "PlanMenu opened without its first item").focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      if (e.target instanceof Node && box.current !== null && box.current.contains(e.target)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onOpenChange]);

  const close = (): void => {
    onOpenChange(false);
    mounted(toggle.current, "PlanMenu without its toggle").focus();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const list = items();
    const to = moved(e.key, list.findIndex((b) => b === document.activeElement), list.length);
    if (to === null) return;
    e.preventDefault();
    list[to].focus();
  };

  const onLeave = (e: FocusEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    onOpenChange(false);
  };

  const exportPlan = (): void => {
    onOpenChange(false);
    void exportFlow(p.session);
  };

  const importPlan = (): void => {
    onOpenChange(false);
    void importFlow(p.registry, p.onOpen);
  };

  const onPrint = p.onPrint;
  const printPlan =
    onPrint === undefined
      ? null
      : (): void => {
          onOpenChange(false);
          onPrint();
        };

  return (
    <div className="plan-menu" ref={box} onKeyDown={onKey} onBlur={onLeave} onMouseDown={(e) => e.preventDefault()}>
      <button
        type="button"
        ref={toggle}
        className="button-small"
        aria-label="Plan menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        ⋯
      </button>
      {open && (
        <div className={MENU_LIST} role="menu" aria-label="Plan">
          <button type="button" role="menuitem" ref={exportItem} className="choice-row" onClick={exportPlan}>
            Export plan…
          </button>
          <button type="button" role="menuitem" ref={importItem} className="choice-row" onClick={importPlan}>
            Import plan…
          </button>
          {printPlan !== null && (
            <button type="button" role="menuitem" ref={printItem} className="choice-row" onClick={printPlan}>
              Print…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanMenu(p: Props) {
  return usesNativeMenu() ? <NativePlanMenu {...p} /> : <HtmlPlanMenu {...p} />;
}
