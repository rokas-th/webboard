import { version } from "../../../package.json";

export const HOLIDAY_ATTRIBUTION = "Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.";

export function AboutText() {
  return (
    <>
      <img className="about-mark" src="/logo-mark.svg" alt="" width={48} height={48} />
      <p>{`WebBoard ${version}`}</p>
      <p className="dimp">{HOLIDAY_ATTRIBUTION}</p>
    </>
  );
}
