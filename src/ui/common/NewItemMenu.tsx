import type { ItemKind } from "../../domain/model";
import { NEW_NAME } from "../palette/commands";
import { useMenu } from "./menu";

const KINDS: readonly ItemKind[] = ["task", "milestone", "group"];

export function NewItemMenu(p: { label: string; className: string; disabled: boolean; onPick(kind: ItemKind): void }) {
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
        <div ref={menu.list} className={menu.listClass} role="menu" aria-label="New item">
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
