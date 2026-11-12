export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function detailsOf(e: unknown): string {
  if (!(e instanceof Error)) return messageOf(e);
  const head = e.message === "" ? e.name : `${e.name}: ${e.message}`;
  if (e.stack === undefined || e.stack === "") return head;
  return e.stack.startsWith(head) ? e.stack : `${head}\n${e.stack}`;
}
