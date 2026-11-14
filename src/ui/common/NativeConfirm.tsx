import { useEffect, useLayoutEffect, useRef } from "react";
import { askNative, type NativeAsk } from "../../services/alert";
import { AppError } from "../../services/ipc";
import { toast } from "./Toast";

export const STALE_CONFIRM = "Nothing was changed: that confirmation was no longer current.";

export function NativeConfirm(p: { ask: NativeAsk; current?: boolean; run(): Promise<void> | void; onClose(): void }) {
  const sent = useRef(false);
  const mounted = useRef(false);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const { ask, run } = latest.current;
    const close = (): void => latest.current.onClose();
    void askNative(ask).then(
      async (answer) => {
        if (answer === "cancel") {
          close();
          return;
        }
        if (!mounted.current || latest.current.current === false) {
          close();
          toast(STALE_CONFIRM, "bad");
          return;
        }
        try {
          await run();
        } finally {
          close();
        }
      },
      (e: unknown) => {
        close();
        if (!(e instanceof AppError)) throw e;
        toast(e.message, "bad");
      },
    );
  }, []);
  return null;
}
