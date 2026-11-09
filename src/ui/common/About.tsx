import { version } from "../../../package.json";
import { Dialog } from "./Dialog";

export const HOLIDAY_ATTRIBUTION = "Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.";

export function About(p: { onClose(): void }) {
  return (
    <Dialog label="About WebBoard" onClose={p.onClose}>
      <p>{`WebBoard ${version}`}</p>
      <p className="dimp">{HOLIDAY_ATTRIBUTION}</p>
      <div className="modal-actions">
        <button type="button" className="button-primary" onClick={p.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
