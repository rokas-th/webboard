import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usesNativeMenu } from "../../services/nativeMenu";
import { ContextMenu, nativeSections, type PickSection, type Point } from "./ContextMenu";
import { useNativeMenu } from "./menu";

export interface PickMenu {
  open(key: string, anchor: HTMLElement, at: Point, sections: readonly PickSection[], onChosen: (id: string) => void): void;
  openFor: string | null;
  node: ReactNode;
}

interface Shown {
  key: string;
  anchor: HTMLElement;
  at: Point;
  sections: readonly PickSection[];
  onChosen(id: string): void;
}

export const pointBelow = (el: HTMLElement): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};

export function usePickMenu(name: string): PickMenu {
  const native = useNativeMenu(name);
  const { show } = native;
  const [shown, setShown] = useState<Shown | null>(null);
  const [nativeKey, setNativeKey] = useState<string | null>(null);
  const current = useRef<Shown | null>(shown);
  useLayoutEffect(() => {
    current.current = shown;
  });
  const open = useCallback(
    (key: string, anchor: HTMLElement, at: Point, sections: readonly PickSection[], onChosen: (id: string) => void): void => {
      if (usesNativeMenu()) {
        setNativeKey(key);
        show(anchor, nativeSections(sections), onChosen);
        return;
      }
      const was = current.current;
      if (was !== null && was.key === key && was.anchor === anchor) {
        current.current = null;
        setShown(null);
        return;
      }
      const next = { key, anchor, at, sections, onChosen };
      current.current = next;
      setShown(next);
    },
    [show],
  );
  const close = useCallback(() => {
    current.current = null;
    setShown(null);
  }, []);
  const node = shown === null ? null : <ContextMenu label={name} at={shown.at} anchor={shown.anchor} sections={shown.sections} onChosen={shown.onChosen} onClose={close} />;
  const openFor = usesNativeMenu() ? (native.open ? nativeKey : null) : shown === null ? null : shown.key;
  return { open, openFor, node };
}
