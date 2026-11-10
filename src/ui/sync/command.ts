import { useState } from "react";
import { Refused } from "../../actions/intents";
import { AppError } from "../../services/ipc";
import { useSyncState } from "../../sync/SyncProvider";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PaneFailures extends Error {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super(failures.map(messageOf).join(" "));
    this.name = "PaneFailures";
    this.failures = failures;
  }
}

export async function enrolThenRestart(enrol: () => Promise<void>, restart: () => Promise<void>): Promise<void> {
  try {
    await enrol();
  } catch (e) {
    await restart().catch((r: unknown) => {
      throw new PaneFailures([e, r]);
    });
    throw e;
  }
  await restart();
}

const shown = (e: unknown): e is AppError | Refused => e instanceof AppError || e instanceof Refused;

export function usePaneCommand(): { errors: readonly string[]; busy: boolean; run(work: () => Promise<void>): void } {
  const { manager } = useSyncState();
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setErrors([]);
    void work()
      .then(
        () => undefined,
        (e: unknown) => {
          const failures = e instanceof PaneFailures ? e.failures : [e];
          if (!failures.every(shown)) throw e;
          setErrors(failures.map((f) => f.message));
          if (failures.some((f) => f instanceof AppError && f.code === "sync.revoked")) void manager.markRevoked();
        },
      )
      .finally(() => setBusy(false));
  };
  return { errors, busy, run };
}
