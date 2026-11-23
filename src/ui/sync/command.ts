import { useState } from "react";
import { Refused } from "../../actions/intents";
import { AppError } from "../../services/ipc";
import { useSyncState } from "../../sync/SyncProvider";
import { toast } from "../common/Toast";

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

export const nameNotSaved = (done: string, message: string): string => `${done}, but the device name could not be saved here: ${message}`;

export async function enrolNamedThenRestart(enrol: () => Promise<void>, rename: () => void, restart: () => Promise<void>, done: string): Promise<void> {
  const refused: (AppError | Refused)[] = [];
  await enrolThenRestart(async () => {
    await enrol();
    try {
      rename();
    } catch (e) {
      if (!shown(e)) throw e;
      refused.push(e);
    }
  }, restart);
  if (refused.length === 0) toast(done);
  else toast(nameNotSaved(done, refused.map((e) => e.message).join(" ")), "bad");
}

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
