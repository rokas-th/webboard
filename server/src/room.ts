import * as decoding from 'lib0/decoding';
import type { Connection, ConnectionContext, WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import { CHUNK_BYTES, COMPACT_DELAY_MS, DEVICE_HEADER, MAX_MESSAGE_BYTES } from './limits';

const MESSAGE_SYNC = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const DEVICE_ID = /^[A-Za-z0-9_-]{11}$/;

function blob(value: SqlStorageValue): Uint8Array {
  if (!(value instanceof ArrayBuffer)) {
    throw new Error(`Room storage holds a ${typeof value} where a BLOB belongs`);
  }
  return new Uint8Array(value);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((offset, part) => {
    out.set(part, offset);
    return offset + part.length;
  }, 0);
  return out;
}

function chunks(bytes: Uint8Array): ArrayBuffer[] {
  return Array.from({ length: Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES)) }, (_, i) => {
    const slice = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const part = new Uint8Array(slice.length);
    part.set(slice);
    return part.buffer;
  });
}

function bytesOf(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  return message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 2 && update[0] === 0 && update[1] === 0;
}

function syncUpdate(bytes: Uint8Array): Uint8Array | null {
  const decoder = decoding.createDecoder(bytes);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
    return null;
  }
  const kind = decoding.readVarUint(decoder);
  if (kind !== SYNC_STEP_2 && kind !== SYNC_UPDATE) {
    return null;
  }
  return decoding.readVarUint8Array(decoder);
}

export class Room extends YServer {
  static options = { hibernate: true };

  stateBytes = 0;

  private tables(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS snapshot (part INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS updates (id INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))',
    );
    sql.exec('CREATE TABLE IF NOT EXISTS revoked (device TEXT PRIMARY KEY)');
  }

  async onLoad(): Promise<undefined> {
    this.tables();
    const sql = this.ctx.storage.sql;
    const snapshot = concat(sql.exec('SELECT data FROM snapshot ORDER BY part').toArray().map((row) => blob(row.data)));
    const rows = sql.exec('SELECT id, data FROM updates ORDER BY id, part').toArray();
    const updates = [...Map.groupBy(rows, (row) => row.id).values()].map((parts) =>
      concat(parts.map((row) => blob(row.data))),
    );
    if (snapshot.length > 0) {
      Y.applyUpdate(this.document, snapshot);
    }
    updates.forEach((update) => Y.applyUpdate(this.document, update));
    this.stateBytes = updates.reduce((sum, update) => sum + update.length, snapshot.length);
    return undefined;
  }

  async onMessage(conn: Connection, message: WSMessage): Promise<void> {
    if (typeof message === 'string') {
      this.handleMessage(conn, message);
      return;
    }
    const bytes = bytesOf(message);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      conn.close(4413, 'Message too large');
      return;
    }
    let update: Uint8Array | null;
    try {
      update = syncUpdate(bytes);
      if (update !== null && !isEmptyUpdate(update)) {
        Y.decodeUpdate(update);
      }
    } catch (error) {
      console.error('Room refused a malformed update:', error);
      conn.close(1007, 'Malformed update');
      return;
    }
    if (update === null || isEmptyUpdate(update)) {
      this.handleMessage(conn, message);
      return;
    }
    try {
      this.append(update);
    } catch (error) {
      console.error('Room could not store an update:', error);
      conn.close(4500, 'Server could not store the update');
      return;
    }
    Y.applyUpdate(this.document, update, conn);
    this.stateBytes += update.length;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACT_DELAY_MS);
    }
  }

  private append(update: Uint8Array): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const id = sql.exec<{ next: number }>('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM updates').one().next;
      chunks(update).forEach((data, part) => sql.exec('INSERT INTO updates (id, part, data) VALUES (?, ?, ?)', id, part, data));
    });
  }

  getConnectionTags(_conn: Connection, ctx: ConnectionContext): string[] {
    const device = ctx.request.headers.get(DEVICE_HEADER);
    if (device === null || !DEVICE_ID.test(device)) {
      throw new Error(`The ${DEVICE_HEADER} header is missing or not a device id`);
    }
    return ['d:' + device];
  }

  onConnect(conn: Connection, ctx: ConnectionContext): void {
    const device = ctx.request.headers.get(DEVICE_HEADER);
    const revoked = this.ctx.storage.sql.exec('SELECT 1 FROM revoked WHERE device = ?', device).toArray().length > 0;
    if (revoked) {
      conn.close(4403, 'Device removed');
      return;
    }
    if (this.stateBytes > MAX_MESSAGE_BYTES) {
      conn.close(4413, 'Too large to sync');
      return;
    }
    super.onConnect(conn, ctx);
  }

  onAlarm(): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const maxId = sql.exec<{ maxId: number }>('SELECT COALESCE(MAX(id), 0) AS maxId FROM updates').one().maxId;
      const encoded = Y.encodeStateAsUpdate(this.document);
      sql.exec('DELETE FROM snapshot');
      chunks(encoded).forEach((data, part) => sql.exec('INSERT INTO snapshot (part, data) VALUES (?, ?)', part, data));
      sql.exec('DELETE FROM updates WHERE id <= ?', maxId);
      this.stateBytes = encoded.length;
    });
  }

  async closeDevice(deviceId: string): Promise<number> {
    this.tables();
    this.ctx.storage.sql.exec('INSERT INTO revoked (device) VALUES (?) ON CONFLICT (device) DO NOTHING', deviceId);
    const open = [...this.getConnections('d:' + deviceId)];
    open.forEach((conn) => conn.close(4403, 'Device removed'));
    return open.length;
  }

  async restoreDevice(deviceId: string): Promise<void> {
    this.tables();
    this.ctx.storage.sql.exec('DELETE FROM revoked WHERE device = ?', deviceId);
  }
}
