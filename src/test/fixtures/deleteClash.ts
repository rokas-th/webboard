import type { PlanSession } from "../../store/session";
import { testSession } from "../session";

export async function deleteClash(): Promise<{ t: Awaited<ReturnType<typeof testSession>>; p: { session: PlanSession; sync(): void } }> {
  const t = await testSession([
    { name: "A", start: "2026-11-10", dur: 3 },
    { name: "B", start: "2026-11-16", dur: 2 },
  ]);
  const p = await t.peer("iphone");
  t.session.apply({ t: "trash", items: ["A"] });
  p.session.apply({ t: "rename", item: "A", name: "Renamed" });
  p.sync();
  return { t, p };
}
