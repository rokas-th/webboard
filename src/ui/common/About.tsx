import { version } from "../../../package.json";
import { Dialog } from "./Dialog";
import { Sheet } from "./Sheet";

export const HOLIDAY_ATTRIBUTION = "Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.";

export const ABOUT_TITLE = "About WebBoard";

export function About(p: { frame?: "dialog" | "sheet"; onClose(): void }) {
  const body = (
    <>
      <p>{`WebBoard ${version}`}</p>
      <p className="dimp">{HOLIDAY_ATTRIBUTION}</p>
      <div className="modal-actions">
        <button type="button" className="button-primary" onClick={p.onClose}>
          Close
        </button>
      </div>
    </>
  );
  if (p.frame === "sheet") {
    return (
      <Sheet open title={ABOUT_TITLE} onClose={p.onClose}>
        <div className="about-sheet">{body}</div>
      </Sheet>
    );
  }
  return (
    <Dialog label={ABOUT_TITLE} onClose={p.onClose}>
      {body}
    </Dialog>
  );
}
