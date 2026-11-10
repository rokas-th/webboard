import { useEffect, useRef, useState } from "react";
import { systemClock } from "./services/clock";
import { AppError, call } from "./services/ipc";
import { guardWindowClose } from "./services/window";
import { Registry } from "./store/registry";
import { toast } from "./ui/common/Toast";
import { stopSync, SyncProvider } from "./sync/SyncProvider";
import { Shell } from "./ui/shell/Shell";

export const RESET_SETTINGS_LINE = "Plan names and the last region are rebuilt; the old file is kept.";
export const REBUILD_LIST_LINE = "Plans on this device are listed again; trashed plans come back; the old list is kept.";

export const closeFailedLine = (message: string): string =>
  `WebBoard could not save everything before closing: ${message} Close the window again to quit.`;

type Recovery = "reset" | "rebuild" | null;

type Start = { k: "opening" } | { k: "open"; registry: Registry } | { k: "failed"; message: string; recovery: Recovery };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const recoveryOf = (e: unknown): Recovery => {
  if (!(e instanceof AppError)) return null;
  if (e.code === "settings.corrupt") return "reset";
  if (e.code === "store.corrupt") return "rebuild";
  return null;
};

export default function App() {
  const [start, setStart] = useState<Start>({ k: "opening" });
  const started = useRef(false);
  const warmed = useRef<Registry | null>(null);
  const live = useRef<Registry | null>(null);
  const closable = useRef<{ close(): Promise<void> } | null>(null);

  const open = (): void => {
    setStart({ k: "opening" });
    Registry.open({ clock: systemClock }).then(
      (registry) => {
        live.current = registry;
        closable.current = {
          close: () => {
            stopSync(registry);
            return registry.close();
          },
        };
        setStart({ k: "open", registry });
      },
      (e: unknown) => {
        console.error(e);
        setStart({ k: "failed", message: messageOf(e), recovery: recoveryOf(e) });
      },
    );
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    open();
  }, []);

  const registry = start.k === "open" ? start.registry : null;

  useEffect(() => {
    if (registry === null || warmed.current === registry) return;
    warmed.current = registry;
    registry.warm().catch((e: unknown) => {
      console.error(e);
      toast(messageOf(e), "bad");
    });
  }, [registry]);

  useEffect(() => {
    const unguarded = (e: unknown): void => {
      console.error(e);
      toast(messageOf(e), "bad");
    };
    const closeFailed = (e: unknown): void => {
      console.error(e);
      toast(messageOf(e), "bad");
      live.current = null;
      setStart({ k: "failed", message: closeFailedLine(messageOf(e)), recovery: null });
    };
    let off: (() => void) | null = null;
    let gone = false;
    guardWindowClose(() => (live.current === null ? null : closable.current), closeFailed).then((unlisten) => {
      if (gone) unlisten();
      else off = unlisten;
    }, unguarded);
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  if (start.k === "opening") return null;
  if (start.k === "open") {
    return (
      <SyncProvider registry={start.registry}>
        <Shell registry={start.registry} clock={systemClock} />
      </SyncProvider>
    );
  }

  const recovery = start.recovery;
  const recover = (cmd: "settings_reset" | "store_set_aside"): void => {
    const run = cmd === "settings_reset" ? call<null>("settings_reset") : call<null>("store_set_aside", { doc: "local" });
    run.then(open, (e: unknown) => setStart({ k: "failed", message: messageOf(e), recovery }));
  };

  return (
    <div className="app">
      <main className="start-failed">
        <p className="start-bad">{start.message}</p>
        <div className="start-actions">
          <button type="button" className="button-primary" onClick={open}>
            Try again
          </button>
          {recovery === "reset" && (
            <button type="button" onClick={() => recover("settings_reset")}>
              Reset settings
            </button>
          )}
          {recovery === "rebuild" && (
            <button type="button" onClick={() => recover("store_set_aside")}>
              Rebuild the plan list
            </button>
          )}
        </div>
        {recovery === "reset" && <p className="start-note">{RESET_SETTINGS_LINE}</p>}
        {recovery === "rebuild" && <p className="start-note">{REBUILD_LIST_LINE}</p>}
      </main>
    </div>
  );
}
