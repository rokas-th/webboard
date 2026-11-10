import { env, listDurableObjectIds } from 'cloudflare:test';
import { randomBase64url, type Result } from '../src/auth';

export function value<V>(result: Result<V>): V {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${result.status} ${result.error}: ${result.message}`);
  }
  return result.value;
}

export function newDoc(): string {
  return randomBase64url(8);
}

export async function roomExists(doc: string): Promise<boolean> {
  const id = env.Room.idFromName(doc);
  return (await listDurableObjectIds(env.Room)).some((listed) => listed.equals(id));
}
