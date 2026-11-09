import type { Action, ActionId, Write } from "../log/types";
import { decodeAction } from "./doc";

export interface UnreadableAction {
  id: ActionId;
  dev: string | null;
  error: string;
}

const devOf = (raw: unknown): string | null => (Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null);

export function readActions(
  entries: Iterable<readonly [string, unknown]>,
  check: (w: Write) => void,
): { ok: Action[]; unreadable: UnreadableAction[] } {
  const ok: Action[] = [];
  const unreadable: UnreadableAction[] = [];
  [...entries].forEach(([id, raw]) => {
    try {
      const a = decodeAction(id, raw);
      a.w.forEach(check);
      ok.push(a);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      unreadable.push({ id, dev: devOf(raw), error: e.message });
    }
  });
  return { ok, unreadable };
}
