import { useEffect, useLayoutEffect, useRef } from "react";
import type { ItemKind } from "../../domain/model";
import { usesNativeMenu, type NativeMenuSection } from "../../services/nativeMenu";
import { NEW_NAME } from "../palette/commands";
import { MENU_LIST, useMenu, useNativeMenu } from "./menu";

const KINDS: readonly ItemKind[] = ["task", "milestone", "group"];

const NEW_ROWS: readonly NativeMenuSection[] = [{ title: null, rows: KINDS.map((kind) => ({ id: kind, title: NEW_NAME[kind], checked: false })) }];

function kindOf(id: string): ItemKind {
  const kind = KINDS.find((k) => k === id);
  if (kind === undefined) throw new Error(`NewItemMenu: the native menu chose ${JSON.stringify(id)}, which is no item kind`);
  return kind;
}

type Props = { label: string; className: string; disabled: boolean; onPick(kind: ItemKind): void };

function NativeNewItemMenu(p: Props) {
  const menu = useNativeMenu("NewItemMenu");
  const toggle = useRef<HTMLButtonElement>(null);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });
  const { open, dismiss } = menu;
  useEffect(() => {
    if (p.disabled && open) dismiss();
  }, [p.disabled, open, dismiss]);
  return (
    <div className="plan-menu">
      <button
        ref={toggle}
        type="button"
        className={p.className}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={p.disabled}
        onClick={() => menu.show(toggle.current, NEW_ROWS, (id) => latest.current.onPick(kindOf(id)))}
      >
        {p.label}
      </button>
    </div>
  );
}

function HtmlNewItemMenu(p: Props) {
  const menu = useMenu("NewItemMenu", '[role="menuitem"]', !p.disabled);
  return (
    <div className="plan-menu" {...menu.box}>
      <button
        ref={menu.toggle}
        type="button"
        className={p.className}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        disabled={p.disabled}
        onClick={menu.onToggle}
      >
        {p.label}
      </button>
      {menu.open && (
        <div ref={menu.list} className={MENU_LIST} role="menu" aria-label="New item">
          {KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="choice-row"
              onClick={() => {
                menu.close();
                p.onPick(kind);
              }}
            >
              {NEW_NAME[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewItemMenu(p: Props) {
  return usesNativeMenu() ? <NativeNewItemMenu {...p} /> : <HtmlNewItemMenu {...p} />;
}
