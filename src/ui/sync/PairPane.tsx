import { useEffect, useState } from "react";
import { syncPairCode, type PairCode } from "../../services/ipc";
import { usePaneCommand } from "./command";
import { clockTime } from "./time";

export function PairPane() {
  const [code, setCode] = useState<PairCode | null>(null);
  const [expired, setExpired] = useState(false);
  const cmd = usePaneCommand();
  useEffect(() => {
    if (code === null) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code]);
  const show = (): void =>
    cmd.run(async () => {
      const next = await syncPairCode();
      setExpired(false);
      setCode(next);
    });
  return (
    <div className="sync-form">
      {code !== null && !expired && (
        <div className="sync-code">
          <p className="sync-code-value">{code.code}</p>
          <p>{`Expires at ${clockTime(code.expiresAt)}`}</p>
          <p className="dim">Single use. Enter it on the new device.</p>
        </div>
      )}
      {code !== null && expired && <p className="dim">Code expired</p>}
      {(code === null || expired) && (
        <div className="sync-buttons">
          <button type="button" className="button-primary" disabled={cmd.busy} onClick={show}>
            {code === null ? "Show pairing code" : "Show a new code"}
          </button>
        </div>
      )}
      {cmd.error !== null && <p className="sync-error bad">{cmd.error}</p>}
    </div>
  );
}
