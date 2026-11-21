import { createContext, useContext } from "react";
import type { ItemId } from "../../domain/model";
import type { ClickMark } from "./clickPair";

export interface DetailApi {
  press(m: ClickMark): void;
  promote(id: ItemId): void;
  rename(item?: ItemId): void;
  step(by: 1 | -1): void;
  order: readonly ItemId[];
}

export const DetailContext = createContext<DetailApi | null>(null);

export function useDetail(): DetailApi {
  const api = useContext(DetailContext);
  if (api === null) throw new Error("useDetail needs a DetailContext provider");
  return api;
}
