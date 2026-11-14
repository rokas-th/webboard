import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { failure, keyData, probeHolidays, probeLine, probeOpen, probePaths, probeSave, sendLine, windowData, type ProbeData, type ProbeEntry } from "./probes";
import "./probe.css";
import { readPlatform } from "../platform";

type Bar = "A" | "B" | "C";
const BARS: readonly { bar: Bar; label: string }[] = [
  { bar: "A", label: "A · touch-action none" },
  { bar: "B", label: "B · pan-x pan-y + hold" },
  { bar: "C", label: "C · pan-x pan-y" },
];
const HOLD_MS = 500;
const SWIPE_PX = 8;
const SETTLE_MS = 150;

type WindowSource = "resize" | "visualViewport" | "observer";

interface Shown {
  n: number;
  line: string;
  bad: boolean;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  t: number;
  moves: number;
}

function isFailure(data: ProbeData): boolean {
  return "error" in data || "thrown" in data;
}

function windowKey(data: ProbeData): string {
  return JSON.stringify([data.inner, data.screen, data.visual, data.insets]);
}

function useProbeLog(): {
  lines: readonly Shown[];
  log: (name: string, data: ProbeData) => void;
  show: (line: string, bad: boolean) => void;
} {
  const [lines, setLines] = useState<readonly Shown[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const count = useRef(0);
  const show = useCallback((line: string, bad: boolean) => {
    count.current += 1;
    const n = count.current;
    setLines((prev) => [{ n, line, bad }, ...prev].slice(0, 200));
  }, []);
  const log = useCallback(
    (name: string, data: ProbeData) => {
      const line = probeLine(name, data);
      show(line, isFailure(data));
      chain.current = chain.current.then(() => sendLine(line).catch((e: unknown) => show(probeLine("probe_log", failure(e)), true)));
    },
    [show],
  );
  return { lines, log, show };
}

function TouchBar({ bar, label, log }: { bar: Bar; label: string; log: (name: string, data: ProbeData) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    if (bar !== "B") return;
    const el = ref.current;
    if (el === null) throw new Error("touch bar B is not mounted");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;
    let start: { x: number; y: number } | null = null;
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      armed = false;
      clear();
      timer = setTimeout(() => {
        armed = true;
        log("touch", { bar, on: "armed", afterMs: HOLD_MS });
      }, HOLD_MS);
    };
    const onMove = (e: TouchEvent): void => {
      if (armed) {
        e.preventDefault();
        return;
      }
      const t = e.touches[0];
      if (start !== null && Math.hypot(t.clientX - start.x, t.clientY - start.y) > SWIPE_PX) clear();
    };
    const onEnd = (e: TouchEvent): void => {
      if (e.touches.length > 0) return;
      clear();
      armed = false;
      start = null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      clear();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [bar, log]);

  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, moves: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    log("touch", { bar, on: "pointerdown", type: e.pointerType, x: Math.round(e.clientX), y: Math.round(e.clientY) });
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || g.id !== e.pointerId) return;
    g.moves += 1;
    if (g.moves === 1) log("touch", { bar, on: "pointermove", first: true, afterMs: Math.round(e.timeStamp - g.t), dx: Math.round(e.clientX - g.x), dy: Math.round(e.clientY - g.y) });
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || g.id !== e.pointerId) return;
    gesture.current = null;
    log("touch", { bar, on: e.type, moves: g.moves, ms: Math.round(e.timeStamp - g.t), dx: Math.round(e.clientX - g.x), dy: Math.round(e.clientY - g.y) });
  };

  return (
    <div
      ref={ref}
      className={`probe-bar probe-bar-${bar}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onContextMenu={() => log("touch", { bar, on: "contextmenu" })}
    >
      {label}
    </div>
  );
}

export default function ProbeApp() {
  const { lines, log, show } = useProbeLog();
  const insetRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const shippedViewport = useRef<string | null>(null);
  const [cover, setCover] = useState(false);

  const run = useCallback(
    (probe: () => Promise<ProbeEntry>) => {
      void probe()
        .then(([name, data]) => log(name, data))
        .catch((e: unknown) => {
          show(probeLine("probe", { thrown: e instanceof Error ? e.message : String(e) }), true);
          console.error(e);
        });
    },
    [log, show],
  );

  useEffect(() => {
    const insetEl = insetRef.current;
    if (insetEl === null) throw new Error("the probe's inset element is not mounted");
    log("ready", { userAgent: navigator.userAgent, touchPoints: navigator.maxTouchPoints, platform: readPlatform(window) });
    log("window", windowData("mount", insetEl));
    run(probePaths);
    run(probeHolidays);
  }, [log, run]);

  useEffect(() => {
    const insetEl = insetRef.current;
    const root = document.getElementById("root");
    if (insetEl === null || root === null) throw new Error("the probe's window elements are not mounted");
    const timers = new Map<WindowSource, ReturnType<typeof setTimeout>>();
    const lastLogged = new Map<WindowSource, string>();
    const settled =
      (on: WindowSource) =>
      (): void => {
        const pending = timers.get(on);
        if (pending !== undefined) clearTimeout(pending);
        timers.set(
          on,
          setTimeout(() => {
            timers.delete(on);
            const data = windowData(on, insetEl);
            const key = windowKey(data);
            if (lastLogged.get(on) === key) return;
            lastLogged.set(on, key);
            log("window", data);
          }, SETTLE_MS),
        );
      };
    const onResize = settled("resize");
    const onVisual = settled("visualViewport");
    const observer = new ResizeObserver(settled("observer"));
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onVisual);
    observer.observe(root);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onVisual);
      observer.disconnect();
    };
  }, [log]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => log("keys", keyData(e));
    const onSelection = (): void => {
      const selection = document.getSelection();
      log("touch", { on: "selectionchange", selected: selection === null ? null : selection.toString().length });
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [log]);

  useEffect(() => {
    const pane = paneRef.current;
    if (pane === null) throw new Error("the probe's touch pane is not mounted");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => log("touch", { on: "scroll", scrollLeft: Math.round(pane.scrollLeft) }), SETTLE_MS);
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (timer !== null) clearTimeout(timer);
      pane.removeEventListener("scroll", onScroll);
    };
  }, [log]);

  const toggleCover = (): void => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta === null) throw new Error("index.html has no viewport meta");
    if (shippedViewport.current === null) {
      const content = meta.getAttribute("content");
      if (content === null) throw new Error("index.html's viewport meta has no content");
      shippedViewport.current = content;
    }
    const shipped = shippedViewport.current;
    const next = !cover;
    meta.setAttribute("content", next ? `${shipped}, viewport-fit=cover` : shipped);
    setCover(next);
    log("window", { on: "viewport", content: meta.getAttribute("content") });
  };

  return (
    <div className="probe">
      <div ref={insetRef} className="probe-insets" aria-hidden="true" />
      <header className="probe-head">
        <h1>WebBoard probe</h1>
      </header>
      <section className="probe-row">
        <button type="button" onClick={() => run(probePaths)}>
          Paths again
        </button>
        <button type="button" onClick={() => run(probeHolidays)}>
          Holidays again
        </button>
        <button type="button" onClick={() => run(probeSave)}>
          Save probe file
        </button>
        <button type="button" onClick={() => run(probeOpen)}>
          Open probe file
        </button>
        <button type="button" onClick={toggleCover}>
          {cover ? "Viewport cover off" : "Viewport cover on"}
        </button>
      </section>
      <section className="probe-row">
        <input className="probe-input" placeholder="Type keys here" aria-label="Key probe input" />
      </section>
      <div ref={paneRef} className="probe-pane">
        <div className="probe-track">
          {BARS.map(({ bar, label }) => (
            <TouchBar key={bar} bar={bar} label={label} log={log} />
          ))}
        </div>
      </div>
      <ol className="probe-log">
        {lines.map(({ n, line, bad }) => (
          <li key={n} className={bad ? "probe-bad" : undefined}>
            {line}
          </li>
        ))}
      </ol>
    </div>
  );
}
