import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

export interface TestClient {
  ydoc: Y.Doc;
  synced: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

const MESSAGE_SYNC = 0;

function frame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export async function connectDoc(open: () => Promise<Response>, ydoc: Y.Doc = new Y.Doc()): Promise<TestClient> {
  const response = await open();
  const ws = response.webSocket;
  if (ws === null) {
    throw new Error(`The server answered ${response.status} instead of a WebSocket`);
  }
  ws.accept();
  ws.binaryType = 'arraybuffer';
  const remote = Symbol('remote');
  const { promise: synced, resolve: markSynced } = Promise.withResolvers<void>();
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
  });
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== remote && ws.readyState === WebSocket.READY_STATE_OPEN) {
      ws.send(frame((encoder) => syncProtocol.writeUpdate(encoder, update)));
    }
  };
  ydoc.on('update', onUpdate);
  void closed.then(() => ydoc.off('update', onUpdate));
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(event.data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    const kind = syncProtocol.readSyncMessage(decoder, encoder, ydoc, remote);
    if (encoding.length(encoder) > 1) {
      ws.send(encoding.toUint8Array(encoder));
    }
    if (kind === syncProtocol.messageYjsSyncStep2) {
      markSynced();
    }
  });
  ws.send(frame((encoder) => syncProtocol.writeSyncStep1(encoder, ydoc)));
  return { ydoc, synced, closed, close: () => ws.close(1000, 'done') };
}
