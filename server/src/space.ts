import { DurableObject } from 'cloudflare:workers';
import * as auth from './auth';
import type { Admission, DeviceEntry, Enrolled, Failure, Result } from './auth';

const CLOSE_CHUNK = 50;
const CLOSE_RETRY_MS = 60_000;

function roomCloseFailed(untold: number): Failure {
  const plans = untold === 1 ? '1 plan was' : `${untold} plans were`;
  const those = untold === 1 ? 'that plan' : 'those plans';
  return {
    ok: false,
    status: 500,
    error: 'internal',
    message: `The device was removed, but ${plans} not told to close its connections. The server tries again every minute; until then the device keeps syncing ${those} while it stays connected.`,
  };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

const ROOM_RESTORE_FAILED: Failure = {
  ok: false,
  status: 500,
  error: 'internal',
  message: 'This device joined, but the server could not reconnect it to every plan. Join again.',
};

export interface RoomCalls {
  close(doc: string, deviceId: string): Promise<number>;
  restore(doc: string, deviceId: string): Promise<void>;
}

export class Space extends DurableObject<Env> {
  readonly rooms: RoomCalls = {
    close: (doc, deviceId) => this.env.Room.getByName(doc).closeDevice(deviceId),
    restore: (doc, deviceId) => this.env.Room.getByName(doc).restoreDevice(deviceId),
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
      const { untold, closed } = await this.tell(id, removed.value.joins);
      return untold > 0 ? roomCloseFailed(untold) : { ok: true, value: { closed } };
    });
  }

  async alarm(): Promise<void> {
    await auth
      .untoldDevices(this.ctx.storage)
      .reduce<Promise<void>>(
        async (done, device) => {
          await done;
          await this.serialised(device, async () => {
            await this.tell(device, auth.untoldOf(this.ctx.storage, device));
          });
        },
        Promise.resolve(),
      );
  }

  private async tell(id: string, docs: readonly string[]): Promise<{ untold: number; closed: number }> {
    const settled = await chunked(docs, CLOSE_CHUNK).reduce<Promise<PromiseSettledResult<number>[]>>(
      async (done, chunk) => [...(await done), ...(await Promise.allSettled(chunk.map((doc) => this.rooms.close(doc, id))))],
      Promise.resolve([]),
    );
    this.logFailures('closeDevice', id, docs, settled);
    const untold = docs.filter((_doc, index) => settled[index].status === 'rejected');
    auth.keepUntold(this.ctx.storage, id, untold);
    if (untold.length > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CLOSE_RETRY_MS);
    }
    const closed = settled.reduce((sum, outcome) => (outcome.status === 'fulfilled' ? sum + outcome.value : sum), 0);
    return { untold: untold.length, closed };
  }

  private async readmit(admitted: Result<Admission>): Promise<Result<Enrolled>> {
    if (!admitted.ok) {
      return admitted;
    }
    const { enrolled, joins } = admitted.value;
    const settled = await Promise.allSettled(joins.map((doc) => this.rooms.restore(doc, enrolled.deviceId)));
    return this.logFailures('restoreDevice', enrolled.deviceId, joins, settled) > 0
      ? ROOM_RESTORE_FAILED
      : { ok: true, value: enrolled };
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
