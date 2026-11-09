import { DurableObject } from 'cloudflare:workers';
import * as auth from './auth';
import type { Admission, DeviceEntry, Enrolled, Result } from './auth';

const ROOM_CLOSE_FAILED: Result<never> = {
  ok: false,
  status: 500,
  error: 'internal',
  message: 'The device was removed, but one of its open connections could not be closed; it stops syncing when that connection drops.',
};

export class Space extends DurableObject<Env> {
  async enrol(secret: string, deviceId: string, deviceName: string, ip: string): Promise<Result<Enrolled>> {
    return this.readmit(
      await auth.enrol(this.ctx.storage, Date.now(), this.env.SETUP_SECRET, secret, deviceId, deviceName, ip),
    );
  }

  async pairCode(token: string): Promise<Result<{ code: string; expiresAt: number }>> {
    return auth.pairCode(this.ctx.storage, Date.now(), token);
  }

  async claim(code: string, deviceId: string, deviceName: string, ip: string): Promise<Result<Enrolled>> {
    return this.readmit(await auth.claim(this.ctx.storage, Date.now(), code, deviceId, deviceName, ip));
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
    const removed = await auth.removeDevice(this.ctx.storage, Date.now(), token, id);
    if (!removed.ok) {
      return removed;
    }
    let closed = 0;
    for (const doc of removed.value.joins) {
      try {
        closed += await this.env.Room.getByName(doc).closeDevice(id);
      } catch (error) {
        console.error(error);
        return ROOM_CLOSE_FAILED;
      }
    }
    return { ok: true, value: { closed } };
  }

  private async readmit(admitted: Result<Admission>): Promise<Result<Enrolled>> {
    if (!admitted.ok) {
      return admitted;
    }
    const { enrolled, joins } = admitted.value;
    await Promise.all(joins.map((doc) => this.env.Room.getByName(doc).restoreDevice(enrolled.deviceId)));
    return { ok: true, value: enrolled };
  }
}
