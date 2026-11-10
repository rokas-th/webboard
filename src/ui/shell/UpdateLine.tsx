import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { version } from "../../../package.json";
import type { UpdateState, Updates } from "../../store/updates";
import { clockTime } from "../sync/time";

export const UpdatesContext = createContext<Updates | null>(null);

export function useUpdates(): Updates | null {
  return useContext(UpdatesContext);
}

export function useUpdateState(updates: Updates | null): UpdateState | null {
  const subscribe = useCallback((cb: () => void) => (updates === null ? () => undefined : updates.subscribe(cb)), [updates]);
  const snapshot = useCallback(() => (updates === null ? null : updates.state()), [updates]);
  return useSyncExternalStore(subscribe, snapshot);
}

type Tone = "plain" | "amber" | "bad";

interface Line {
  text: string;
  tone: Tone;
  control: { label: string; act: "check" | "install" } | null;
}

function lineOf(s: UpdateState): Line | null {
  switch (s.k) {
    case "idle":
    case "closeFailed":
      return null;
    case "checking":
      return { text: "Checking for updates…", tone: "plain", control: null };
    case "current":
      return { text: `Up to date · checked ${clockTime(s.at)}`, tone: "plain", control: null };
    case "available":
      return { text: `WebBoard ${s.version} is available`, tone: "amber", control: { label: "Install and restart", act: "install" } };
    case "downloading":
      return { text: `Downloading ${s.version}…${s.percent === null ? "" : ` ${s.percent}%`}`, tone: "plain", control: null };
    case "installing":
      return { text: `Installing ${s.version}…`, tone: "plain", control: null };
    case "checkFailed":
      return { text: `Could not check for updates: ${s.message}`, tone: "bad", control: { label: "Try again", act: "check" } };
    case "installFailed":
      return { text: `Could not install ${s.version}: ${s.message}`, tone: "bad", control: { label: "Try again", act: "install" } };
  }
}

export function UpdateLine(p: { updates: Updates }) {
  const state = useUpdateState(p.updates);
  if (state === null) throw new Error("UpdateLine: the update store gave no state");
  const line = lineOf(state);
  const control = line?.control ?? null;
  return (
    <div className="update-line">
      <p className="update-version">{`WebBoard ${version}`}</p>
      {line !== null && (
        <p className={line.tone === "plain" ? "update-status" : `update-status ${line.tone}`} title={line.text}>
          {line.text}
        </p>
      )}
      {control !== null && (
        <button type="button" className="button-small" onClick={() => void (control.act === "install" ? p.updates.install() : p.updates.check())}>
          {control.label}
        </button>
      )}
    </div>
  );
}
