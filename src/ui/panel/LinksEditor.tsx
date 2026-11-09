import type { Item, ItemId, Link, LinkType } from "../../domain/model";
import { linkKey } from "../../domain/model";
import { wouldLoop } from "../../domain/schedule";
import { childrenOf, liveLinks } from "../../plan/project";
import type { PlanView } from "../../store/doc";
import type { Run } from "../run";

export const ADD_DEPENDENCY = "+ Add a dependency…";

const TYPES: readonly LinkType[] = ["FS", "SS", "FF", "SF"];

const TYPE_TITLE: Readonly<Record<LinkType, string>> = {
  FS: "starts after it finishes",
  SS: "starts after it starts",
  FF: "finishes after it finishes",
  SF: "finishes after it starts",
};

const typeOf = (v: string): LinkType => {
  const found = TYPES.find((t) => t === v);
  if (found === undefined) throw new Error(`LinksEditor: no link type ${v}`);
  return found;
};

export const lagText = (lag: number): string => (lag === 0 ? "0d" : lag > 0 ? `+${lag}d` : `−${-lag}d`);

const nameOf = (view: PlanView, id: ItemId): string => {
  const it = view.plan.items.get(id);
  if (it === undefined) throw new Error(`LinksEditor: no item ${id}`);
  return it.name;
};

function DepRow(p: { view: PlanView; link: Link; readOnly: boolean; run: Run }) {
  const l = p.link;
  const set = (type: LinkType, lag: number): void => {
    p.run.run({ t: "link", from: l.from, to: l.to, type, lag });
  };
  const name = nameOf(p.view, l.from);
  return (
    <div className="dep" data-dep={l.from}>
      <span className="dep-name" title={name}>
        {name}
      </span>
      {p.readOnly ? (
        <span className="val">{l.type}</span>
      ) : (
        <select
          aria-label="Dependency type"
          value={l.type}
          onChange={(e) => {
            const next = typeOf(e.target.value);
            if (next !== l.type) set(next, l.lag);
          }}
        >
          {TYPES.map((t) => (
            <option key={t} value={t} title={TYPE_TITLE[t]}>
              {t}
            </option>
          ))}
        </select>
      )}
      <span className="inline lag" title="Lag in working days">
        {!p.readOnly && (
          <button type="button" className="step" aria-label="Less lag" onClick={() => set(l.type, l.lag - 1)}>
            −
          </button>
        )}
        <span className="val">{lagText(l.lag)}</span>
        {!p.readOnly && (
          <button type="button" className="step" aria-label="More lag" onClick={() => set(l.type, l.lag + 1)}>
            +
          </button>
        )}
      </span>
      {!p.readOnly && (
        <button type="button" className="x" aria-label="Remove dependency" onClick={() => p.run.run({ t: "unlink", link: linkKey(l.from, l.to) })}>
          ×
        </button>
      )}
    </div>
  );
}

export function LinksEditor(p: { view: PlanView; item: Item; readOnly: boolean; run: Run }) {
  const plan = p.view.plan;
  const id = p.item.id;
  const live = liveLinks(plan);
  const preds = live.filter((l) => l.to === id);
  const succs = live.filter((l) => l.from === id);
  const linked = new Set(preds.map((l) => l.from));
  const tree = (parent: ItemId | null): Item[] => childrenOf(plan, parent).flatMap((i) => [i, ...tree(i.id)]);
  const candidates = tree(null).filter(
    (o) => o.id !== id && o.kind !== "group" && !o.trashed && !linked.has(o.id) && wouldLoop(live, { from: o.id, to: id, type: "FS", lag: 0 }) === null,
  );
  return (
    <>
      <h2>Depends on</h2>
      <div className="deps">
        {preds.length === 0 && <p className="note">{p.readOnly ? "Nothing." : "Nothing. Drag from another bar’s end dot onto this one, or pick below."}</p>}
        {preds.map((l) => (
          <DepRow key={l.from} view={p.view} link={l} readOnly={p.readOnly} run={p.run} />
        ))}
      </div>
      {!p.readOnly && !p.item.trashed && (
        <div className="suggest">
          <select
            aria-label="Add a dependency"
            value=""
            onChange={(e) => {
              if (e.target.value === "") return;
              p.run.run({ t: "link", from: e.target.value, to: id, type: "FS", lag: 0 });
            }}
          >
            <option value="">{ADD_DEPENDENCY}</option>
            {candidates.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="note">FS starts after it finishes · SS after it starts · FF finishes after it finishes · SF finishes after it starts. Lag in working days.</p>
      {succs.length > 0 && (
        <>
          <h2>Needed by</h2>
          <div className="links">
            {succs.map((l) => (
              <div key={l.to} className="link-row" data-succ={l.to}>
                <span className="t">{nameOf(p.view, l.to)}</span>
                <span className="repo">{l.type}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
