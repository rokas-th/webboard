import type { PlanId } from "../../domain/model";
import type { PlanListing } from "../../store/registry";
import { EXAMPLE_TAG, LOCAL_TAG, localLineText, moveAllLabel, onThisDeviceOnly } from "./moving";

export function EntryTag(p: { listing: PlanListing; shown: boolean }) {
  if (!p.shown || p.listing.trashed || p.listing.space !== null) return null;
  if (p.listing.example) return <span className="entry-tag tag-example">{EXAMPLE_TAG}</span>;
  if (onThisDeviceOnly(p.listing)) return <span className="entry-tag tag-local">{LOCAL_TAG}</span>;
  return null;
}

export function LocalLine(p: { plans: readonly PlanListing[]; shown: boolean; onMoveAll(ids: readonly PlanId[]): void }) {
  const ids = p.plans.filter(onThisDeviceOnly).map((l) => l.id);
  if (!p.shown || ids.length === 0) return null;
  return (
    <div className="local-line">
      <p>{localLineText(ids.length)}</p>
      <button type="button" className="button-small" onClick={() => p.onMoveAll(ids)}>
        {moveAllLabel(ids.length)}
      </button>
    </div>
  );
}
