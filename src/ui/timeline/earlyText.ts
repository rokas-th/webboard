import type { LinkType } from "../../domain/model";

export const EARLY: Readonly<Record<LinkType, (pred: string) => string>> = {
  FS: (pred) => `Started before ${pred} finished`,
  SS: (pred) => `Started before ${pred} started`,
  FF: (pred) => `Finished before ${pred} finished`,
  SF: (pred) => `Finished before ${pred} started`,
};
