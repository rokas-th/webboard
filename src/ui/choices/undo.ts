import type { Built } from "../../actions/intents";
import { OfferRefused, type Offer } from "../../actions/undo";
import type { PlanSession } from "../../store/session";

export function requestUndo(session: PlanSession, open: (offer: Offer) => void): Built | null {
  const offer = session.undoOffer();
  if (offer !== null) {
    open(offer);
    return null;
  }
  try {
    return session.undo();
  } catch (e) {
    if (e instanceof OfferRefused) {
      open(e.offer);
      return null;
    }
    throw e;
  }
}
