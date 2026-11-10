import { version } from "../../../package.json";
import { Dialog } from "./Dialog";
import { Sheet } from "./Sheet";

export const HOLIDAY_ATTRIBUTION = "Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.";

export const ABOUT_TITLE = "About WebBoard";

function AboutText() {
  return (
    <>
      <img className="about-mark" src="/logo-mark.svg" alt="" width={48} height={48} />
      <p>{`WebBoard ${version}`}</p>
      <p className="dimp">{HOLIDAY_ATTRIBUTION}</p>
    </>
  );
}

export function About(p: { frame?: "dialog" | "sheet"; onClose(): void }) {
  if (p.frame === "sheet") {
    return (
      <Sheet open title={ABOUT_TITLE} onClose={p.onClose}>
        <div className="about-sheet">
          <AboutText />
        </div>
      </Sheet>
    );
  }
  return (
    <Dialog label={ABOUT_TITLE} onClose={p.onClose}>
      <AboutText />
      <div className="modal-actions">
        <button type="button" className="button-primary" onClick={p.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
