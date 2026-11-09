import { useEffect, useRef, useState } from "react";
import type { RegionRef, Tuning } from "../../domain/calendar";
import { fmtShort, isCalendarDate, toDay, yearOf, type IsoDate } from "../../domain/dates";
import { AppError, call } from "../../services/ipc";
import { toast } from "../common/Toast";
import { regionText } from "../panel/calendarText";
import { messageOf } from "./message";

type Source = "none" | "openholidays" | "govuk" | "opm" | "ics";

type Division = Extract<RegionRef, { src: "govuk" }>["division"];

interface Country {
  code: string;
  name: string;
  src: string;
}

interface Subdivision {
  code: string;
  name: string;
  children: readonly Subdivision[];
}

interface IcsEvent {
  date: IsoDate;
  name: string;
}

type Load<T> = { k: "loading" } | { k: "ok"; value: T } | { k: "failed"; message: string };

const SOURCES: readonly { value: Source; label: string }[] = [
  { value: "none", label: "No holiday region" },
  { value: "openholidays", label: "OpenHolidays" },
  { value: "govuk", label: "GOV.UK" },
  { value: "opm", label: "US federal (OPM)" },
  { value: "ics", label: "Calendar link (ICS)" },
];

const DIVISIONS: readonly Division[] = ["england-and-wales", "scotland", "northern-ireland"];

const WHOLE = "*";

export const divisionOf = (v: string): Division | null => {
  if (v === "") return null;
  const found = DIVISIONS.find((d) => d === v);
  if (found === undefined) throw new Error(`No GOV.UK division ${v}`);
  return found;
};

const sourceOf = (v: string): Source => {
  const found = SOURCES.find((s) => s.value === v);
  if (found === undefined) throw new Error(`No holiday source ${v}`);
  return found.value;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const shape = (cmd: string): AppError => new AppError("ipc.shape", `${cmd} answered an unexpected shape`);

const isCountry = (v: unknown): v is Country => isRecord(v) && typeof v.code === "string" && typeof v.name === "string" && typeof v.src === "string";

const isSubdivision = (v: unknown): v is Subdivision =>
  isRecord(v) && typeof v.code === "string" && typeof v.name === "string" && Array.isArray(v.children) && v.children.every(isSubdivision);

const isEvent = (v: unknown): v is IcsEvent => isRecord(v) && typeof v.date === "string" && isCalendarDate(v.date) && typeof v.name === "string";

const listOf = <T,>(cmd: string, raw: unknown, check: (v: unknown) => v is T): T[] => {
  if (!Array.isArray(raw) || !raw.every(check)) throw shape(cmd);
  return raw;
};

const fetchCountries = async (): Promise<Country[]> =>
  listOf("holidays_countries", await call<unknown>("holidays_countries"), isCountry).filter((c) => c.src === "openholidays");

const fetchSubdivisions = async (country: string): Promise<Subdivision[]> =>
  listOf("holidays_subdivisions", await call<unknown>("holidays_subdivisions", { country }), isSubdivision);

const fetchIcs = async (url: string): Promise<IcsEvent[]> => listOf("holidays_ics_preview", await call<unknown>("holidays_ics_preview", { url }), isEvent);

const flatten = (list: readonly Subdivision[], depth: number): { code: string; label: string }[] =>
  list.flatMap((s) => [{ code: s.code, label: `${"  ".repeat(depth)}${s.name}` }, ...flatten(s.children, depth + 1)]);

const webAddress = (link: string): URL | null => {
  try {
    return new URL(link);
  } catch (e) {
    if (e instanceof TypeError) return null;
    throw e;
  }
};

export const consumerHost = (address: URL): boolean => {
  const host = address.hostname.toLowerCase();
  return host === "calendar.google.com" || host.endsWith(".icloud.com");
};

function useLoad<T>(key: string | null, fetch: (key: string) => Promise<T>): { state: Load<T> | null; retry(): void } {
  const [attempt, setAttempt] = useState(0);
  const [got, setGot] = useState<{ key: string; attempt: number; state: Load<T> } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    fetch(key).then(
      (value) => {
        if (live) setGot({ key, attempt, state: { k: "ok", value } });
      },
      (e: unknown) => {
        if (live) setGot({ key, attempt, state: { k: "failed", message: messageOf(e) } });
        if (!(e instanceof AppError)) throw e;
      },
    );
    return () => {
      live = false;
    };
  }, [key, attempt, fetch]);
  const state: Load<T> | null = key === null ? null : got !== null && got.key === key && got.attempt === attempt ? got.state : { k: "loading" };
  return { state, retry: () => setAttempt((a) => a + 1) };
}

function Failed(p: { message: string; onRetry(): void }) {
  return (
    <div className="cal-failed">
      <span className="note bad">{p.message}</span>
      <button type="button" className="button-small" onClick={p.onRetry}>
        Try again
      </button>
    </div>
  );
}

export function RegionPicker(p: {
  region: RegionRef | null;
  tuning: ReadonlyMap<IsoDate, Tuning>;
  onPick(r: RegionRef | null): void;
  onTune(date: IsoDate, t: Tuning | null): void;
}) {
  const [source, setSource] = useState<Source>(p.region === null ? "none" : p.region.src);
  const [country, setCountry] = useState(p.region !== null && p.region.src === "openholidays" ? p.region.country : "");
  const [url, setUrl] = useState(p.region !== null && p.region.src === "ics" ? p.region.url : "");
  const [icsName, setIcsName] = useState(p.region !== null && p.region.src === "ics" ? p.region.name : "");
  const [ics, setIcs] = useState<Load<{ events: IcsEvent[]; consumer: boolean }> | null>(null);
  const icsRequest = useRef(0);
  const countries = useLoad(source === "openholidays" ? "countries" : null, fetchCountries);
  const subdivisions = useLoad(source === "openholidays" && country !== "" ? country : null, fetchSubdivisions);
  const region = p.region;
  const onPick = p.onPick;
  const subs = subdivisions.state;
  const noSubdivisions = subs !== null && subs.k === "ok" && subs.value.length === 0;
  const picked = region !== null && region.src === "openholidays" && region.country === country ? region : null;
  const pickedCountry = picked !== null;

  useEffect(() => {
    if (noSubdivisions && !pickedCountry) onPick({ src: "openholidays", country, subdivision: null });
  }, [noSubdivisions, pickedCountry, onPick, country]);

  const pickSource = (s: Source): void => {
    setSource(s);
    if (s === "none") onPick(null);
    if (s === "opm") onPick({ src: "opm" });
  };

  const loadIcs = (): void => {
    const link = url.trim();
    const name = icsName.trim();
    const address = webAddress(link);
    if (address === null || name === "") {
      toast("A calendar link needs a web address and a name.", "bad");
      return;
    }
    const consumer = consumerHost(address);
    icsRequest.current += 1;
    const request = icsRequest.current;
    setIcs({ k: "loading" });
    fetchIcs(link).then(
      (events) => {
        if (icsRequest.current !== request) return;
        setIcs({ k: "ok", value: { events, consumer } });
        onPick({ src: "ics", url: link, name });
      },
      (e: unknown) => {
        if (icsRequest.current === request) setIcs({ k: "failed", message: messageOf(e) });
        if (!(e instanceof AppError)) throw e;
      },
    );
  };

  const ticked = (consumer: boolean, date: IsoDate): boolean => {
    const t = p.tuning.get(date);
    return consumer ? t?.kind === "off" : t?.kind !== "work";
  };

  const tick = (consumer: boolean, date: IsoDate, on: boolean): void => {
    if (consumer) p.onTune(date, on ? { kind: "off" } : null);
    else p.onTune(date, on ? null : { kind: "work" });
  };

  const cs = countries.state;

  return (
    <div className="region-picker">
      <p className="region-now">{region === null ? "No holiday region" : `Region: ${regionText(region)}`}</p>
      <select aria-label="Holiday source" value={source} onChange={(e) => pickSource(sourceOf(e.target.value))}>
        {SOURCES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {source === "openholidays" && cs !== null && cs.k === "loading" && <span className="note">Loading countries…</span>}
      {source === "openholidays" && cs !== null && cs.k === "failed" && <Failed message={cs.message} onRetry={countries.retry} />}
      {source === "openholidays" && cs !== null && cs.k === "ok" && (
        <select aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">Choose a country…</option>
          {cs.value.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {source === "openholidays" && subs !== null && subs.k === "loading" && <span className="note">Loading regions…</span>}
      {source === "openholidays" && subs !== null && subs.k === "failed" && <Failed message={subs.message} onRetry={subdivisions.retry} />}
      {source === "openholidays" && subs !== null && subs.k === "ok" && subs.value.length > 0 && (
        <select
          aria-label="Subdivision"
          value={picked === null ? "" : (picked.subdivision ?? WHOLE)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") return;
            onPick({ src: "openholidays", country, subdivision: v === WHOLE ? null : v });
          }}
        >
          <option value="">Choose a region…</option>
          <option value={WHOLE}>Whole country</option>
          {flatten(subs.value, 0).map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </select>
      )}
      {source === "govuk" && (
        <select
          aria-label="Division"
          value={region !== null && region.src === "govuk" ? region.division : ""}
          onChange={(e) => {
            const division = divisionOf(e.target.value);
            if (division !== null) onPick({ src: "govuk", division });
          }}
        >
          <option value="">Choose a division…</option>
          {DIVISIONS.map((d) => (
            <option key={d} value={d}>
              {regionText({ src: "govuk", division: d })}
            </option>
          ))}
        </select>
      )}
      {source === "ics" && (
        <div className="ics-load">
          <input type="text" aria-label="Calendar link" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input type="text" aria-label="Calendar name" placeholder="Name, e.g. Company holidays" value={icsName} onChange={(e) => setIcsName(e.target.value)} />
          <button type="button" className="button-small" onClick={loadIcs}>
            Load
          </button>
        </div>
      )}
      {source === "ics" && ics !== null && ics.k === "loading" && <span className="note">Loading the calendar…</span>}
      {source === "ics" && ics !== null && ics.k === "failed" && <Failed message={ics.message} onRetry={loadIcs} />}
      {source === "ics" && ics !== null && ics.k === "ok" && (
        <ul className="ics-events" aria-label="Calendar events">
          {ics.value.events.map((ev) => {
            const consumer = ics.value.consumer;
            return (
              <li key={`${ev.date} ${ev.name}`}>
                <label>
                  <input type="checkbox" checked={ticked(consumer, ev.date)} onChange={(e) => tick(consumer, ev.date, e.target.checked)} />
                  <span className="when">{`${fmtShort(ev.date)} ${yearOf(toDay(ev.date))}`}</span>
                  <span>{ev.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
