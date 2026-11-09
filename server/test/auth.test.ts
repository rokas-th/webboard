import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  claim,
  consumeTicket,
  devices,
  enrol,
  normalizeCode,
  pairCode,
  removeDevice,
  sha256Hex,
  ticket,
  type Result,
} from '../src/auth';
import { int, text } from '../src/sql';

const SECRET = env.SETUP_SECRET;
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
const DEV_C = 'devC0000000';
const T = 1_800_000_000_000;
const UNKNOWN = { ok: false, status: 401, error: 'unauthorized', message: 'This device is not known to the space. Set up sync again.' };
const REVOKED = { ok: false, status: 403, error: 'revoked', message: 'This device was removed from the space.' };
const BAD_CODE = {
  ok: false,
  status: 404,
  error: 'bad_code',
  message: 'The pairing code is wrong, used or expired. Show a new code on a device in the space.',
};
const BAD_DEVICE = { ok: false, status: 400, error: 'bad_request', message: 'The device id is not valid. Update WebBoard on this device.' };
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function inSpace<R>(name: string, run: (storage: DurableObjectStorage) => Promise<R>): Promise<R> {
  return runInDurableObject(env.Space.getByName('t-' + name), (_space, state) => run(state.storage));
}

function value<V>(result: Result<V>): V {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${result.status} ${result.error}: ${result.message}`);
  }
  return result.value;
}

function count(storage: DurableObjectStorage, table: string): number {
  return int(storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one(), 'n');
}

async function enrolled(storage: DurableObjectStorage, device: string, now = T): Promise<{ spaceId: string; token: string }> {
  const admitted = value(await enrol(storage, now, SECRET, SECRET, device, 'Device ' + device, '9.9.9.9'));
  return { spaceId: admitted.enrolled.spaceId, token: admitted.enrolled.token };
}

async function liveCode(storage: DurableObjectStorage, token: string, now = T): Promise<string> {
  return value(await pairCode(storage, now, token)).code;
}

function otherCode(code: string): string {
  const swap = code[0] === 'A' ? 'B' : 'A';
  return swap + code.slice(1);
}

describe('auth', () => {
  it('stores tokens only as SHA-256 hashes', async () => {
    await inSpace('hashes', async (storage) => {
      const admitted = value(await enrol(storage, T, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1'));
      expect(admitted.enrolled.spaceId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(admitted.enrolled.deviceId).toBe(DEV_A);
      expect(admitted.enrolled.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const hash = text(storage.sql.exec('SELECT token_hash FROM devices WHERE id = ?', DEV_A).one(), 'token_hash');
      expect(hash).toBe(await sha256Hex(admitted.enrolled.token));
      const code = await liveCode(storage, admitted.enrolled.token);
      const issued = value(await ticket(storage, T, admitted.enrolled.token, 'docA0000000'));
      expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const secrets = [admitted.enrolled.token, code, code.replace('-', ''), issued.ticket];
      const tables = ['meta', 'devices', 'codes', 'tickets', 'joins', 'attempts'];
      const cells = tables.flatMap((table) =>
        storage.sql.exec(`SELECT * FROM ${table}`).toArray().flatMap((row) => Object.values(row)),
      );
      expect(cells.filter((cell) => secrets.includes(String(cell)))).toEqual([]);
      expect(text(storage.sql.exec('SELECT hash FROM tickets').one(), 'hash')).toBe(await sha256Hex(issued.ticket));
      expect(text(storage.sql.exec('SELECT hash FROM codes').one(), 'hash')).toBe(await sha256Hex(code.replace('-', '')));
    });
  });

  it('answers not_configured without a setup secret of 32 bytes', async () => {
    await inSpace('not-configured', async (storage) => {
      const refused = {
        ok: false,
        status: 503,
        error: 'not_configured',
        message: 'The server has no setup secret. Run wrangler secret put SETUP_SECRET.',
      };
      const short = 'x'.repeat(31);
      expect(await enrol(storage, T, undefined, short, DEV_A, 'Mac', '1.1.1.1')).toEqual(refused);
      expect(await enrol(storage, T, '', '', DEV_A, 'Mac', '1.1.1.1')).toEqual(refused);
      expect(await enrol(storage, T, short, short, DEV_A, 'Mac', '1.1.1.1')).toEqual(refused);
      const wide = 'é'.repeat(16);
      expect(value(await enrol(storage, T, wide, wide, DEV_A, 'Mac', '1.1.1.1')).enrolled.deviceId).toBe(DEV_A);
      expect(count(storage, 'devices')).toBe(1);
      expect(count(storage, 'attempts')).toBe(0);
    });
  });

  it('401s carry the exact messages', async () => {
    await inSpace('messages', async (storage) => {
      expect(await enrol(storage, T, SECRET, SECRET + 'x', DEV_A, 'Mac', '1.1.1.1')).toEqual({
        ok: false,
        status: 401,
        error: 'unauthorized',
        message: 'The setup secret is not correct.',
      });
      const { spaceId } = await enrolled(storage, DEV_A);
      expect(await devices(storage, 'tok_unknown')).toEqual(UNKNOWN);
      expect(await pairCode(storage, T, 'tok_unknown')).toEqual(UNKNOWN);
      expect(await ticket(storage, T, 'tok_unknown', 'ix-' + spaceId)).toEqual(UNKNOWN);
      expect(await removeDevice(storage, T, 'tok_unknown', DEV_A)).toEqual(UNKNOWN);
    });
  });

  it('refuses a device id that is not 11 base64url characters', async () => {
    await inSpace('device-id', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const bad = ['short', 'devA000000!', 'devA00000000'];
      const devicesBefore = count(storage, 'devices');
      const attemptsBefore = count(storage, 'attempts');
      for (const id of bad) {
        expect(await enrol(storage, T, SECRET, SECRET, id, 'Mac', '1.1.1.1')).toEqual(BAD_DEVICE);
        expect(await claim(storage, T, code, id, 'Mac', '1.1.1.1')).toEqual(BAD_DEVICE);
      }
      expect(count(storage, 'devices')).toBe(devicesBefore);
      expect(count(storage, 'attempts')).toBe(attemptsBefore);
      expect(value(await claim(storage, T, code, DEV_B, 'iPad', '1.1.1.1')).enrolled.deviceId).toBe(DEV_B);
    });
  });

  it('enrol creates the space once and joins it after', async () => {
    await inSpace('create-join', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B, T + 5);
      expect(b.spaceId).toBe(a.spaceId);
      expect(count(storage, 'meta')).toBe(1);
      const listed = value(await devices(storage, b.token)).devices;
      expect(listed).toEqual([
        { id: DEV_A, name: 'Device ' + DEV_A, createdAt: T, lastSeenAt: T, current: false },
        { id: DEV_B, name: 'Device ' + DEV_B, createdAt: T + 5, lastSeenAt: T + 5, current: true },
      ]);
    });
  });

  it('enrol re-admits a known device with a new token', async () => {
    await inSpace('readmit-enrol', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(await devices(storage, a.token)).toEqual(REVOKED);
      const again = value(await enrol(storage, T + 10, SECRET, SECRET, DEV_A, 'Mac Studio', '1.1.1.1'));
      expect(again.enrolled).toEqual({ spaceId: a.spaceId, deviceId: DEV_A, token: again.enrolled.token });
      expect(again.enrolled.token).not.toBe(a.token);
      expect(again.joins).toEqual(['docA0000000']);
      expect(await devices(storage, a.token)).toEqual(UNKNOWN);
      const listed = value(await devices(storage, again.enrolled.token)).devices;
      expect(listed.filter((d) => d.id === DEV_A)).toEqual([
        { id: DEV_A, name: 'Mac Studio', createdAt: T, lastSeenAt: T + 10, current: true },
      ]);
      expect(count(storage, 'devices')).toBe(2);
    });
  });

  it('refuses the 6th enrolment from one IP after 5 failures in 10 min', async () => {
    await inSpace('enrol-limit', async (storage) => {
      for (let i = 0; i < 5; i += 1) {
        expect(await enrol(storage, T, SECRET, 'wrong', DEV_A, 'Mac', '1.1.1.1')).toMatchObject({ ok: false, status: 401 });
      }
      expect(await enrol(storage, T, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong setup secrets from this address.',
        retryAfter: 600,
      });
      expect(value(await enrol(storage, T, SECRET, SECRET, DEV_B, 'Mac', '2.2.2.2')).enrolled.deviceId).toBe(DEV_B);
      expect(await enrol(storage, T + 599_999, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1')).toMatchObject({
        ok: false,
        status: 429,
        retryAfter: 1,
      });
      expect(value(await enrol(storage, T + 600_000, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1')).enrolled.deviceId).toBe(DEV_A);
    });
  });

  it('old attempts are pruned', async () => {
    await inSpace('prune', async (storage) => {
      for (let i = 0; i < 5; i += 1) {
        await enrol(storage, T, SECRET, 'wrong', DEV_A, 'Mac', '1.1.1.1');
      }
      expect(count(storage, 'attempts')).toBe(5);
      await enrol(storage, T + 600_000, SECRET, 'wrong', DEV_A, 'Mac', '2.2.2.2');
      expect(count(storage, 'attempts')).toBe(1);
    });
  });

  it('makes pairing codes of the code alphabet that live 10 minutes', async () => {
    await inSpace('code-shape', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const made = value(await pairCode(storage, T, token));
      expect(made.code).toMatch(CODE);
      expect(made.expiresAt).toBe(T + 600_000);
    });
  });

  it('reads a pairing code typed loosely', async () => {
    expect(normalizeCode(' ab0o-1il L ')).toBe('AB001111');
    expect(normalizeCode('abcd efgh')).toBe('ABCDEFGH');
    await inSpace('code-loose', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const typed = code.toLowerCase().replace('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l');
      expect(value(await claim(storage, T, typed, DEV_B, 'iPad', '1.1.1.1')).enrolled.deviceId).toBe(DEV_B);
    });
  });

  it('a pairing code claims once, until it expires', async () => {
    await inSpace('code-once', async (storage) => {
      const { spaceId, token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const claimed = value(await claim(storage, T + 599_999, code, DEV_B, 'iPad', '1.1.1.1'));
      expect(claimed.enrolled).toEqual({ spaceId, deviceId: DEV_B, token: claimed.enrolled.token });
      expect(claimed.joins).toEqual([]);
      expect(await claim(storage, T + 599_999, code, DEV_C, 'iPhone', '1.1.1.1')).toEqual(BAD_CODE);
      const late = await liveCode(storage, token);
      expect(await claim(storage, T + 600_000, late, DEV_C, 'iPhone', '1.1.1.1')).toEqual(BAD_CODE);
    });
  });

  it('refuses a 4th live pairing code in a space', async () => {
    await inSpace('code-limit', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const codes = [await liveCode(storage, token), await liveCode(storage, token), await liveCode(storage, token)];
      expect(await pairCode(storage, T, token)).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Three pairing codes are already live. Use one or wait until one expires.',
        retryAfter: 600,
      });
      value(await claim(storage, T, codes[1], DEV_B, 'iPad', '1.1.1.1'));
      expect(await pairCode(storage, T, token)).toMatchObject({ ok: true });
      expect(await pairCode(storage, T, token)).toMatchObject({ ok: false, status: 429 });
      expect(await pairCode(storage, T + 600_000, token)).toMatchObject({ ok: true });
    });
  });

  it('refuses the 6th claim from one IP after 5 failures in 10 min', async () => {
    await inSpace('claim-ip-limit', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      for (let i = 0; i < 5; i += 1) {
        expect(await claim(storage, T, otherCode(code), DEV_B, 'iPad', '1.1.1.1')).toEqual(BAD_CODE);
      }
      expect(await claim(storage, T, code, DEV_B, 'iPad', '1.1.1.1')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong pairing codes.',
        retryAfter: 600,
      });
      expect(value(await claim(storage, T, code, DEV_B, 'iPad', '2.2.2.2')).enrolled.deviceId).toBe(DEV_B);
    });
  });

  it('refuses even a right code after 20 failed claims in a space in 10 min', async () => {
    await inSpace('claim-space-limit', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      for (const host of [1, 2, 3, 4, 5]) {
        for (let i = 0; i < 4; i += 1) {
          expect(await claim(storage, T, otherCode(code), DEV_B, 'iPad', `10.0.0.${host}`)).toEqual(BAD_CODE);
        }
      }
      expect(await claim(storage, T, code, DEV_B, 'iPad', '10.0.0.6')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong pairing codes.',
        retryAfter: 600,
      });
      const fresh = await liveCode(storage, token, T + 600_000);
      expect(value(await claim(storage, T + 600_000, fresh, DEV_B, 'iPad', '10.0.0.6')).enrolled.deviceId).toBe(DEV_B);
    });
  });

  it('a claim with a known device id re-admits it', async () => {
    await inSpace('readmit-claim', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await ticket(storage, T, a.token, 'ix-' + a.spaceId));
      value(await removeDevice(storage, T, b.token, DEV_A));
      const code = await liveCode(storage, b.token);
      const again = value(await claim(storage, T + 1, code, DEV_A, 'iPad 2', '1.1.1.1'));
      expect(again.enrolled.deviceId).toBe(DEV_A);
      expect([...again.joins].sort()).toEqual(['docA0000000', 'ix-' + a.spaceId].sort());
      expect(await devices(storage, a.token)).toEqual(UNKNOWN);
      expect(value(await devices(storage, again.enrolled.token)).devices.map((d) => [d.id, d.name])).toEqual([
        [DEV_A, 'iPad 2'],
        [DEV_B, 'Device ' + DEV_B],
      ]);
    });
  });

  it('a ticket is single use, lives 60 s and is bound to its doc', async () => {
    await inSpace('ticket-life', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const doc = 'docA0000000';
      const first = value(await ticket(storage, T, token, doc));
      expect(first.expiresAt).toBe(T + 60_000);
      const refused = await consumeTicket(storage, T, first.ticket, 'docB0000000');
      expect(refused).toMatchObject({ ok: false, status: 401, error: 'unauthorized' });
      expect(await consumeTicket(storage, T + 59_999, first.ticket, doc)).toEqual({ ok: true, value: { deviceId: DEV_A } });
      expect(await consumeTicket(storage, T + 59_999, first.ticket, doc)).toEqual(refused);
      const second = value(await ticket(storage, T, token, doc));
      expect(await consumeTicket(storage, T + 60_000, second.ticket, doc)).toEqual(refused);
      expect(await consumeTicket(storage, T, 'tik_unknown', doc)).toEqual(refused);
    });
  });

  it('refuses tickets for docs outside the space', async () => {
    await inSpace('ticket-docs', async (storage) => {
      const { spaceId, token } = await enrolled(storage, DEV_A);
      const bad = { ok: false, status: 400, error: 'bad_request', message: 'The document id is not valid. Update WebBoard on this device.' };
      expect(await ticket(storage, T, token, 'local')).toEqual(bad);
      expect(await ticket(storage, T, token, 'ix-other00000')).toEqual(bad);
      expect(await ticket(storage, T, token, '../x')).toEqual(bad);
      expect(await ticket(storage, T, token, 'ix-' + spaceId)).toMatchObject({ ok: true });
      expect(await ticket(storage, T, token, 'docA0000000')).toMatchObject({ ok: true });
      expect(count(storage, 'joins')).toBe(2);
    });
  });

  it('issuing a ticket records the join, the last seen time and drops tickets older than an hour', async () => {
    await inSpace('ticket-issue', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      value(await ticket(storage, T, token, 'docA0000000'));
      value(await ticket(storage, T + 1_000, token, 'docA0000000'));
      expect(count(storage, 'joins')).toBe(1);
      expect(count(storage, 'tickets')).toBe(2);
      value(await ticket(storage, T + 3_599_999, token, 'docB0000000'));
      expect(count(storage, 'tickets')).toBe(3);
      value(await ticket(storage, T + 3_600_000, token, 'docB0000000'));
      expect(count(storage, 'tickets')).toBe(3);
      value(await ticket(storage, T + 3_601_000, token, 'docB0000000'));
      expect(count(storage, 'tickets')).toBe(3);
      expect(count(storage, 'joins')).toBe(2);
      expect(int(storage.sql.exec('SELECT last_seen_at FROM devices WHERE id = ?', DEV_A).one(), 'last_seen_at')).toBe(
        T + 3_601_000,
      );
    });
  });

  it('consuming a ticket of a removed device answers 403', async () => {
    await inSpace('ticket-revoked', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      const issued = value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(await consumeTicket(storage, T, issued.ticket, 'docA0000000')).toEqual(REVOKED);
    });
  });

  it('a removed device keeps its hash and answers 403 everywhere', async () => {
    await inSpace('revoked-token', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      expect(value(await removeDevice(storage, T, b.token, DEV_A))).toEqual({ joins: ['docA0000000'] });
      expect(text(storage.sql.exec('SELECT token_hash FROM devices WHERE id = ?', DEV_A).one(), 'token_hash')).toBe(
        await sha256Hex(a.token),
      );
      expect(await pairCode(storage, T, a.token)).toEqual(REVOKED);
      expect(await ticket(storage, T, a.token, 'docA0000000')).toEqual(REVOKED);
      expect(await devices(storage, a.token)).toEqual(REVOKED);
      expect(await removeDevice(storage, T, a.token, DEV_B)).toEqual(REVOKED);
    });
  });

  it('devices leaves out removed devices', async () => {
    await inSpace('device-list', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(value(await devices(storage, b.token)).devices.map((d) => d.id)).toEqual([DEV_B]);
      expect(a.spaceId).toBe(b.spaceId);
    });
  });

  it('refuses to remove the calling device or an unknown one', async () => {
    await inSpace('remove-refusals', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      expect(await removeDevice(storage, T, a.token, DEV_A)).toEqual({
        ok: false,
        status: 400,
        error: 'bad_request',
        message: 'Remove this device from another device.',
      });
      expect(await removeDevice(storage, T, a.token, DEV_C)).toEqual({
        ok: false,
        status: 404,
        error: 'not_found',
        message: 'This device is not in the space.',
      });
      expect(value(await devices(storage, a.token)).devices.map((d) => d.id)).toEqual([DEV_A]);
    });
  });
});
