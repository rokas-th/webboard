import type { Built, Intent } from "../../actions/intents";
import { workCalendar } from "../../domain/calendar";
import { toDay, toIso } from "../../domain/dates";
import type { Item, ItemId, ItemKind } from "../../domain/model";
import type { Clock } from "../../services/clock";
import type { Registry } from "../../store/registry";
import { childrenOf } from "../../plan/project";
import type { PlanSession } from "../../store/session";
import { conflictSuccessor, countedConflicts } from "../choices/HeadCounts";
import { baselineDefault } from "../panel/Baselines";
import type { UiState, ViewKind, Zoom } from "../state";

export interface Command {
  id: string;
  group: string;
  label: string;
  keys?: string;
  run(): void;
}

export interface CommandCtx {
  session: PlanSession | null;
  registry: Registry;
  ui: UiState;
  setUi(p: Partial<UiState>): void;
  run: ((i: Intent) => Built | null) | null;
  undo: (() => Built | null) | null;
  redo: (() => Built | null) | null;
  readOnly: boolean;
  mac: boolean;
  clock: Clock;
  newPlan(): void;
  reveal(target: ItemId | "today"): void;
}

const NEW_NAME: Readonly<Record<ItemKind, string>> = { task: "New task", milestone: "New milestone", group: "New group" };

const VIEWS: readonly (readonly [ViewKind, string, string])[] = [
  ["timeline", "Timeline", "1"],
  ["board", "Now · Next · Later", "2"],
  ["list", "List", "3"],
];

const ZOOMS: readonly (readonly [Zoom, string])[] = [
  ["W", "Week"],
  ["M", "Month"],
  ["Q", "Quarter"],
];

const STEPS: readonly number[] = [1, -1, 5, -5];

const signed = (n: number): string => `${n > 0 ? "+" : ""}${n}`;

const days = (n: number): string => `${Math.abs(n)} working ${Math.abs(n) === 1 ? "day" : "days"}`;

function arrowKeys(mac: boolean, n: number, resize: boolean): string {
  const arrow = n > 0 ? "→" : "←";
  const mods = [resize ? (mac ? "⇧" : "Shift ") : "", Math.abs(n) === 5 ? (mac ? "⌥" : "Alt ") : ""].join("");
  return mods + arrow;
}

function itemOf(session: PlanSession, id: ItemId): Item {
  const it = session.view().plan.items.get(id);
  if (it === undefined) throw new Error(`Command: no item ${id}`);
  return it;
}

export function createdItem(built: Built): ItemId {
  const w = built.action.w.find((x) => x.u.startsWith("e:"));
  if (w === undefined) throw new Error(`Command: the create “${built.action.lbl}” wrote no item`);
  return w.u.slice(2);
}

function placeOf(session: PlanSession, selected: ItemId | null): { parent: ItemId | null; after: ItemId | null } {
  if (selected === null) return { parent: null, after: null };
  const sel = itemOf(session, selected);
  return sel.kind === "group" ? { parent: sel.id, after: null } : { parent: sel.place.parent, after: sel.id };
}

function newItem(ctx: CommandCtx, session: PlanSession, run: (i: Intent) => Built | null, kind: ItemKind): void {
  const place = placeOf(session, ctx.ui.selected);
  const name = NEW_NAME[kind];
  const start = kind === "group" ? null : toIso(workCalendar(session.view().plan.calendar).after(toDay(ctx.clock.today())));
  const intent: Intent =
    kind === "task" ? { t: "create", kind, name, ...place, start, dur: 3 } : { t: "create", kind, name, ...place, start };
  const built = run(intent);
  if (built === null) return;
  const id = createdItem(built);
  ctx.setUi({ selected: id, naming: id });
}

function resize(session: PlanSession, run: (i: Intent) => Built | null, id: ItemId, n: number): void {
  const it = itemOf(session, id);
  if (it.kind !== "task" || it.schedule === null) return;
  const dur = Math.max(1, it.schedule.dur + n);
  if (dur === it.schedule.dur) return;
  run({ t: "resize", item: id, dur });
}

function editCommands(ctx: CommandCtx, session: PlanSession, run: (i: Intent) => Built | null): Command[] {
  const sel = ctx.ui.selected;
  if (sel === null) return [];
  const it = session.view().plan.items.get(sel);
  if (it === undefined || it.trashed) return [];
  const nudges = STEPS.map(
    (n): Command => ({
      id: `nudge${signed(n)}`,
      group: "Edit",
      label: `Move ${n > 0 ? "later" : "earlier"} by ${days(n)}`,
      keys: arrowKeys(ctx.mac, n, false),
      run: () => {
        run({ t: "move", items: [sel], days: n });
      },
    }),
  );
  const resizes = STEPS.map(
    (n): Command => ({
      id: `resize${signed(n)}`,
      group: "Edit",
      label: `${n > 0 ? "Longer" : "Shorter"} by ${days(n)}`,
      keys: arrowKeys(ctx.mac, n, true),
      run: () => resize(session, run, sel, n),
    }),
  );
  const trash: Command = {
    id: "trash",
    group: "Edit",
    label: `Move “${it.name}” to the Trash`,
    keys: "Delete",
    run: () => {
      run({ t: "trash", items: [sel] });
    },
  };
  return [...nudges, ...resizes, trash];
}

function planCommands(ctx: CommandCtx, session: PlanSession): Command[] {
  const run = ctx.run;
  const undo = ctx.undo;
  const redo = ctx.redo;
  if (run === null || undo === null || redo === null) throw new Error("Commands: an open plan needs run, undo and redo");
  const view = session.view();
  const create = (kind: ItemKind, keys?: string): Command => ({
    id: `new-${kind}`,
    group: "Create",
    label: NEW_NAME[kind],
    ...(keys === undefined ? {} : { keys }),
    run: () => newItem(ctx, session, run, kind),
  });
  const views = VIEWS.map(([kind, label, keys]): Command => ({ id: `view-${kind}`, group: "View", label, keys, run: () => ctx.setUi({ view: kind }) }));
  const zooms = ZOOMS.map(([z, label]): Command => ({ id: `zoom-${z}`, group: "Zoom", label, run: () => ctx.setUi({ view: "timeline", zoom: z }) }));
  const baselines = [...view.plan.baselines.values()].map(
    (b): Command => ({
      id: `baseline-show:${b.id}`,
      group: "View",
      label: ctx.ui.baseline === b.id ? `Hide ${b.name}` : `Compare with ${b.name}`,
      run: () => ctx.setUi(ctx.ui.baseline === b.id ? { baseline: null } : { view: "timeline", baseline: b.id }),
    }),
  );
  const firstConflict = countedConflicts(view)[0];
  const conflict: Command[] =
    firstConflict === undefined
      ? []
      : [
          {
            id: "go-first-conflict",
            group: "Plan",
            label: "Go to first conflict",
            run: () => {
              const now = session.view();
              const c = countedConflicts(now)[0];
              if (c === undefined) throw new Error("Go to first conflict: there is no conflict");
              const succ = conflictSuccessor(now, c);
              ctx.setUi({ selected: succ });
              ctx.reveal(succ);
            },
          },
        ];
  const tree = (parent: ItemId | null): Item[] =>
    childrenOf(view.plan, parent)
      .filter((it) => !it.trashed)
      .flatMap((it) => [it, ...(it.kind === "group" ? tree(it.id) : [])]);
  const goTo = tree(null).map(
      (it): Command => ({
        id: `goto:${it.id}`,
        group: "Go to",
        label: it.name,
        run: () => {
          ctx.setUi({ selected: it.id });
          ctx.reveal(it.id);
        },
      }),
  );
  return [
    create("task", "N"),
    create("milestone"),
    create("group"),
    ...views,
    { id: "today", group: "View", label: "Jump to today", run: () => ctx.reveal("today") },
    ...baselines,
    ...zooms,
    { id: "calendar", group: "Plan", label: "Change calendar: region, working days, closures", run: () => ctx.setUi({ dialog: { t: "calendar" } }) },
    {
      id: "save-baseline",
      group: "Plan",
      label: "Save baseline",
      run: () => {
        run({ t: "baseline", op: "save", name: baselineDefault(ctx.clock.today()) });
      },
    },
    ...conflict,
    {
      id: "undo",
      group: "Edit",
      label: "Undo",
      keys: ctx.mac ? "⌘Z" : "Ctrl Z",
      run: () => {
        undo();
      },
    },
    {
      id: "redo",
      group: "Edit",
      label: "Redo",
      keys: ctx.mac ? "⇧⌘Z" : "Ctrl Y",
      run: () => {
        redo();
      },
    },
    ...editCommands(ctx, session, run),
    ...goTo,
  ];
}

export function commands(ctx: CommandCtx): Command[] {
  const current = ctx.ui.plan;
  const openPlans = ctx.registry
    .plans()
    .filter((l) => !l.trashed && l.id !== current)
    .map(
      (l): Command => ({
        id: `open-plan:${l.id}`,
        group: "Plan",
        label: `Open ${l.name ?? "Loading…"}`,
        run: () => ctx.setUi({ plan: l.id, selected: null, dialog: null }),
      }),
    );
  const always: Command[] = [
    { id: "new-plan", group: "File", label: "New plan", run: () => ctx.newPlan() },
    ...openPlans,
    { id: "palette", group: "Help", label: "Command palette", keys: ctx.mac ? "⌘K" : "Ctrl K", run: () => ctx.setUi({ dialog: { t: "palette" } }) },
    { id: "about", group: "Help", label: "About WebBoard", run: () => ctx.setUi({ dialog: { t: "about" } }) },
  ];
  return ctx.session === null ? always : [...planCommands(ctx, ctx.session), ...always];
}
