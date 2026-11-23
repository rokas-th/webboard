import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { readPlatform } from "../../platform";
import { applyLook, zoomNative } from "../../theme/apply";
import { detailsOf, messageOf } from "../common/errorText";
import { Switch } from "../common/Switch";
import { toast } from "../common/Toast";
import { lookOf, SMALL_TEXT_ZOOM, textSizesOn, type Density, type TextSize } from "../device";
import { useDevice, useLook } from "../DeviceProvider";
import { SegChoice } from "./General";
import { Row } from "./Row";
import { cappedLookRows, LOOK_LABELS } from "./sections";

const SECTION = "theme";

const ROW_CLASS = "general-row";

export const GLOW_HINT = "Solid outlines instead of neon glow. Increase Contrast always uses them.";

export const TEXT_SIZE_FAILED = "Text size could not be set";

const DENSITY_OPTIONS: readonly (readonly [Density, string])[] = [
  ["comfortable", "Comfortable"],
  ["compact", "Compact"],
];

const TEXT_OPTIONS: readonly (readonly [TextSize, string])[] = [
  ["small", "Small"],
  ["default", "Default"],
];

const ZOOMS: Readonly<Record<TextSize, number>> = { small: SMALL_TEXT_ZOOM, default: 1 };

export const zoomOf = (text: TextSize): number => ZOOMS[text];

const textLabel = (text: TextSize): string => {
  const found = TEXT_OPTIONS.find(([v]) => v === text);
  if (found === undefined) throw new Error(`Settings: no Text size label for ${text}`);
  return found[1];
};

export const textSizeFailed = (message: string, kept: TextSize): string => `${TEXT_SIZE_FAILED}: ${message}. The page stays at ${textLabel(kept)}.`;

export function useAppliedLook(): void {
  const look = useLook();
  const { set } = useDevice();
  const { density, text, glow } = look;
  useLayoutEffect(() => {
    applyLook(document.documentElement, { density, text, glow });
  }, [density, text, glow]);
  const zoomed = useRef<TextSize | null>(null);
  useEffect(() => {
    const before = zoomed.current;
    if (before === text) return;
    zoomed.current = text;
    if (before === null && text === "default") return;
    zoomNative(zoomOf(text)).catch((e: unknown) => {
      console.error(e);
      const kept = before ?? "default";
      zoomed.current = kept;
      set({ text: kept });
      toast(textSizeFailed(messageOf(e), kept), "bad", detailsOf(e));
    });
  }, [text, set]);
}

export function Look() {
  const platform = readPlatform(window);
  const capped = cappedLookRows(platform);
  const { prefs, set } = useDevice();
  const look = lookOf(prefs, platform);
  const ids = useId();
  const glowHint = `${ids}-glow`;
  const reduced = look.glow === "reduced";
  const sizes = textSizesOn(platform);
  const textOptions = TEXT_OPTIONS.filter(([v]) => sizes.includes(v));
  return (
    <>
      {!capped.includes("density") && (
        <Row section={SECTION} row="density" label={LOOK_LABELS.density} rowClassName={ROW_CLASS}>
          <SegChoice field="density" label={LOOK_LABELS.density} options={DENSITY_OPTIONS} value={look.density} onChange={(density) => set({ density })} />
        </Row>
      )}
      {!capped.includes("text-size") && (
        <Row section={SECTION} row="text-size" label={LOOK_LABELS["text-size"]} rowClassName={ROW_CLASS}>
          <SegChoice field="text-size" label={LOOK_LABELS["text-size"]} options={textOptions} value={look.text} onChange={(text) => set({ text })} />
        </Row>
      )}
      <Row section={SECTION} row="glow" label={LOOK_LABELS.glow} rowClassName={ROW_CLASS} hint={{ id: glowHint, text: GLOW_HINT }}>
        <Switch label={LOOK_LABELS.glow} checked={reduced} describedBy={glowHint} onToggle={() => set({ glow: reduced ? "full" : "reduced" })} />
      </Row>
    </>
  );
}
