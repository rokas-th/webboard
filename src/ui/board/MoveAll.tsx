import { useLayoutEffect, useRef } from "react";
import type { StepId } from "../../domain/model";
import type { Step } from "../../domain/steps";
import { usesNativeMenu, type NativeMenuSection } from "../../services/nativeMenu";
import { MENU_LIST, useMenu, useNativeMenu } from "../common/menu";
import { STALE_CONFIRM } from "../common/NativeConfirm";
import { toast } from "../common/Toast";
import { MOVE_ALL } from "./text";

type Props = { steps: readonly Step[]; onPick(step: StepId): void };

const pickLive = (offered: readonly Step[], live: readonly Step[], id: string, onPick: (step: StepId) => void): void => {
  if (!offered.some((s) => s.id === id)) throw new Error(`MoveAll: the menu chose ${JSON.stringify(id)}, which it never offered`);
  const found = live.find((s) => s.id === id);
  if (found === undefined) {
    toast(STALE_CONFIRM, "bad");
    return;
  }
  onPick(found.id);
};

function NativeMoveAll(p: Props) {
  const menu = useNativeMenu("MoveAll");
  const toggle = useRef<HTMLButtonElement>(null);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });
  const sections: readonly NativeMenuSection[] = [{ title: null, rows: p.steps.map((s) => ({ id: s.id, title: s.name, checked: false })) }];
  return (
    <div className="plan-menu move-all-menu">
      <button
        ref={toggle}
        type="button"
        className="button-small move-all"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => {
          const offered = p.steps;
          menu.show(toggle.current, sections, (id) => pickLive(offered, latest.current.steps, id, latest.current.onPick));
        }}
      >
        {MOVE_ALL}
      </button>
    </div>
  );
}

function HtmlMoveAll(p: Props) {
  const menu = useMenu("MoveAll", '[role="menuitem"]', true);
  return (
    <div className="plan-menu move-all-menu" {...menu.box}>
      <button ref={menu.toggle} type="button" className="button-small move-all" aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.onToggle}>
        {MOVE_ALL}
      </button>
      {menu.open && (
        <div ref={menu.list} className={MENU_LIST} role="menu" aria-label={MOVE_ALL}>
          {p.steps.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              className="choice-row"
              onClick={() => {
                menu.close();
                p.onPick(s.id);
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MoveAll(p: Props) {
  return usesNativeMenu() ? <NativeMoveAll {...p} /> : <HtmlMoveAll {...p} />;
}
