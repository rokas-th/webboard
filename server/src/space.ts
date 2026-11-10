import { DurableObject } from 'cloudflare:workers';
import * as auth from './auth';
import type { Admission, DeviceEntry, Enrolled, Failure, Result } from './auth';

const CLOSE_CHUNK = 50;
const PURGE_RETRY_MS = 60_000;

function roomCloseFailed(untold: number): Failure {
  const plans = untold === 1 ? '1 plan was' : `${untold} plans were`;
  const those = untold === 1 ? 'that plan' : 'those plans';
  return {
    ok: false,
    status: 500,
    error: 'internal',
    message: `The device was removed, but ${plans} not told to close its connections. The server tries again in a minute, then less often, at least once an hour; until then the device keeps syncing ${those} while it stays connected.`,
  };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function roomRestoreFailed(untold: number): Failure {
  const plans = untold === 1 ? '1 plan was' : `${untold} plans were`;
  return {
    ok: false,
    status: 500,
    error: 'internal',
    message: `This device joined, but ${plans} not told to let it connect again. Join again.`,
  };
}

export interface RoomCalls {
  close(doc: string, deviceId: string): Promise<number>;
  restore(doc: string, deviceId: string): Promise<void>;
  purge(doc: string): Promise<number>;
}

export class Space extends DurableObject<Env> {
  readonly rooms: RoomCalls = {
    close: (doc, deviceId) => this.env.Room.getByName(doc).closeDevice(deviceId),
    restore: (doc, deviceId) => this.env.Room.getByName(doc).restoreDevice(deviceId),
    purge: (doc) => this.env.Room.getByName(doc).purge(),
  };

  private readonly queues = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => auth.schema(ctx.storage.sql));
  }

  async enrol(secret: string, deviceId: string, deviceName: string, ip: string): Promise<Result<Enrolled>> {
    return this.serialised(deviceId, async () =>
      this.readmit(await auth.enrol(this.ctx.storage, Date.now(), this.env.SETUP_SECRET, secret, deviceId, deviceName, ip)),
    );
  }

  async pairCode(token: string): Promise<Result<{ code: string; expiresAt: number }>> {
    return auth.pairCode(this.ctx.storage, Date.now(), token);
  }

  async claim(code: string, deviceId: string, deviceName: string, ip: string): Promise<Result<Enrolled>> {
    return this.serialised(deviceId, async () =>
      this.readmit(await auth.claim(this.ctx.storage, Date.now(), code, deviceId, deviceName, ip)),
    );
  }

  async ticket(token: string, doc: string): Promise<Result<{ ticket: string; expiresAt: number }>> {
    return auth.ticket(this.ctx.storage, Date.now(), token, doc);
  }

  async consumeTicket(ticket: string, doc: string): Promise<Result<{ deviceId: string }>> {
    return auth.consumeTicket(this.ctx.storage, Date.now(), ticket, doc);
  }

  async devices(token: string): Promise<Result<{ devices: DeviceEntry[] }>> {
    return auth.devices(this.ctx.storage, token);
  }

  async removeDevice(token: string, id: string): Promise<Result<{ closed: number }>> {
    return this.serialised(id, async (): Promise<Result<{ closed: number }>> => {
      const removed = await auth.removeDevice(this.ctx.storage, Date.now(), token, id);
      if (!removed.ok) {
        return removed;
      }
      const { untold, closed } = await this.tell(id, removed.value.joins, true);
      await this.arm();
      return untold > 0 ? roomCloseFailed(untold) : { ok: true, value: { closed } };
    });
  }

  async purgePlan(token: string, doc: string): Promise<Result<{ closed: number }>> {
    const purged = await auth.purgePlan(this.ctx.storage, Date.now(), token, doc);
    if (!purged.ok) {
      return purged;
    }
    await this.arm();
    const erased = await this.erase(purged.value.device, doc);
    if (erased === null) {
      return auth.PURGE_PENDING;
    }
    return { ok: true, value: { closed: erased } };
  }

  async alarm(): Promise<void> {
    await auth.dueUntoldDevices(this.ctx.storage, Date.now()).reduce<Promise<void>>(async (done, device) => {
      await done;
      await this.serialised(device, async () => {
        await this.tell(device, auth.untoldOf(this.ctx.storage, device), false);
        if (auth.hasUntoldRetry(this.ctx.storage, device)) {
          auth.backOffUntold(this.ctx.storage, Date.now(), device);
        }
      });
    }, Promise.resolve());
    await auth.unerased(this.ctx.storage).reduce<Promise<void>>(async (done, { doc, device }) => {
      await done;
      await this.erase(device, doc);
    }, Promise.resolve());
    await this.arm();
  }

  private async erase(device: string, doc: string): Promise<number | null> {
    const settled = await Promise.allSettled([this.rooms.purge(doc)]);
    this.logFailures('purge', device, [doc], settled);
    const [outcome] = settled;
    if (outcome.status === 'rejected') {
      return null;
    }
    auth.markErased(this.ctx.storage, Date.now(), doc);
    return outcome.value;
  }

  private async arm(): Promise<void> {
    const retry = auth.nextUntoldRetry(this.ctx.storage);
    const wanted = [
      ...(retry === null ? [] : [retry]),
      ...(auth.unerased(this.ctx.storage).length > 0 ? [Date.now() + PURGE_RETRY_MS] : []),
    ];
    if (wanted.length === 0) {
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    const at = Math.min(...wanted, ...(current === null ? [] : [current]));
    if (at !== current) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  private async inChunks<T>(docs: readonly string[], call: (doc: string) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
    return chunked(docs, CLOSE_CHUNK).reduce<Promise<PromiseSettledResult<T>[]>>(
      async (done, chunk) => [...(await done), ...(await Promise.allSettled(chunk.map(call)))],
      Promise.resolve([]),
    );
  }

  private async tell(id: string, docs: readonly string[], fresh: boolean): Promise<{ untold: number; closed: number }> {
    const settled = await this.inChunks(docs, (doc) => this.rooms.close(doc, id));
    this.logFailures('closeDevice', id, docs, settled);
    const untold = docs.filter((_doc, index) => settled[index].status === 'rejected');
    auth.keepUntold(this.ctx.storage, Date.now(), id, untold, fresh);
    const closed = settled.reduce((sum, outcome) => (outcome.status === 'fulfilled' ? sum + outcome.value : sum), 0);
    return { untold: untold.length, closed };
  }

  private async readmit(admitted: Result<Admission>): Promise<Result<Enrolled>> {
    if (!admitted.ok) {
      return admitted;
    }
    const { enrolled, joins } = admitted.value;
    const settled = await this.inChunks(joins, (doc) => this.rooms.restore(doc, enrolled.deviceId));
    const untold = this.logFailures('restoreDevice', enrolled.deviceId, joins, settled);
    return untold > 0 ? roomRestoreFailed(untold) : { ok: true, value: enrolled };
  }

  private logFailures(call: string, deviceId: string, docs: readonly string[], settled: readonly PromiseSettledResult<unknown>[]): number {
    const failures = settled.flatMap((outcome, index) => (outcome.status === 'rejected' ? [{ doc: docs[index], reason: outcome.reason }] : []));
    failures.forEach(({ doc, reason }) => console.error(`Space: ${call}(${deviceId}) failed in room ${doc}`, reason));
    return failures.length;
  }

  private serialised<T>(deviceId: string, run: () => Promise<T>): Promise<T> {
    const current = (this.queues.get(deviceId) ?? Promise.resolve()).then(run);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(deviceId, settled);
    void settled.then(() => {
      if (this.queues.get(deviceId) === settled) {
        this.queues.delete(deviceId);
      }
    });
    return current;
  }
}
