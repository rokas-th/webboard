export function framed(name: string, bytes: Uint8Array): ArrayBuffer {
  const encoded = new TextEncoder().encode(name);
  const out = new Uint8Array(4 + encoded.length + bytes.length);
  new DataView(out.buffer).setUint32(0, encoded.length, true);
  out.set(encoded, 4);
  out.set(bytes, 4 + encoded.length);
  return out.buffer;
}
