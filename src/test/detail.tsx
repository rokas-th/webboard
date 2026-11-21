import type { ReactNode } from "react";
import { DetailContext, type DetailApi } from "../ui/detail/DetailContext";
import { useUiValue } from "../ui/state";

export function BareDetail(p: { children: ReactNode }) {
  const { ui, setUi } = useUiValue();
  const api: DetailApi = {
    order: [],
    press: (m) => setUi(ui.view === "timeline" ? { selected: m.item, follow: m.item } : { selected: m.item }),
    promote: (id) => {
      throw new Error(`BareDetail: no item modal to open ${id} in`);
    },
    rename: (item) => {
      throw new Error(`BareDetail: no rename for ${item ?? "the selection"}`);
    },
    step: () => {
      throw new Error("BareDetail: no stepping");
    },
  };
  return <DetailContext.Provider value={api}>{p.children}</DetailContext.Provider>;
}
