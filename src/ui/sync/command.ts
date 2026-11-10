import { useState } from "react";
import { Refused } from "../../actions/intents";
import { AppError } from "../../services/ipc";
import { useSyncState } from "../../sync/SyncProvider";

export function usePaneCommand(): { error: string | null; busy: boolean; run(work: () => Promise<void>): void } {
  const { manager } = useSyncState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void work()
      .then(
        () => undefined,
        (e: unknown) => {
          if (!(e instanceof AppError || e instanceof Refused)) throw e;
          setError(e.message);
          if (e instanceof AppError && e.code === "sync.revoked") void manager.markRevoked();
        },
      )
      .finally(() => setBusy(false));
  };
  return { error, busy, run };
}
