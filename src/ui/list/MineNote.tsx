import type { MeState } from "../../domain/me";
import { CHOOSE_ME, meGoneText, MINE_NEEDS_ME } from "../people/text";
import { useUiValue } from "../state";
import type { ScopeId } from "./prefs";

export interface MineLine {
  text: string;
  choose: boolean;
}

export function mineLine(scope: ScopeId, me: MeState): MineLine | null {
  if (scope !== "mine") return null;
  switch (me.kind) {
    case "live":
      return null;
    case "none":
      return { text: MINE_NEEDS_ME, choose: true };
    case "removed":
      return { text: meGoneText(me.name), choose: false };
    case "missing":
      return { text: meGoneText(null), choose: false };
  }
}

export function MineNote(p: { line: MineLine; className: string }) {
  const { setUi } = useUiValue();
  return (
    <p className={`${p.className} mine-note`} role="status">
      <span className="mine-note-text">{p.line.text}</span>
      {p.line.choose && (
        <>
          {" "}
          <button type="button" className="link-button mine-choose" onClick={() => setUi({ settings: "general", settingsRow: "me" })}>
            {CHOOSE_ME}
          </button>
        </>
      )}
    </p>
  );
}
