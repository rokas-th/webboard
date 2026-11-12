import { isHex } from "./colour";
import { derive, type Seeds, type Tokens } from "./derive";

export type Group = "webboard" | "colorfetcher" | "mine";

export interface Theme {
  id: string;
  name: string;
  note: string;
  group: Group;
  seeds: Seeds;
  exact?: Partial<Tokens>;
}

const seeds = (line: string): Seeds => {
  const parts = line.split(" ");
  if (parts.length !== 5 || !parts.every(isHex)) throw new Error(`Bad preset seeds: ${line}`);
  const [ground, text, accent, highlight, danger] = parts;
  return { ground, text, accent, highlight, danger };
};

export const PRESETS: readonly Theme[] = [
  {
    id: "cyberdeck",
    name: "Cyberdeck",
    note: "Default",
    group: "webboard",
    seeds: seeds("#0A0A14 #C8D3E0 #24E0FF #FFB000 #FF3B6B"),
    exact: {
      panel: "#10101E",
      "panel-2": "#16162A",
      line: "#23233D",
      "cyan-dim": "#158CA6",
      dim: "#7485A0",
      "dot-idle": "#3A4258",
      heading: "#EAF3FF",
      "danger-bg": "#2A0F1A",
      "on-accent": "#000000",
      hover: "rgba(36, 224, 255, 0.06)",
      active: "rgba(255, 176, 0, 0.08)",
      scrim: "rgba(4, 4, 10, 0.72)",
    },
  },
  { id: "phosphor", name: "Phosphor", note: "Green terminal", group: "webboard", seeds: seeds("#060C09 #B9D6C3 #3DFF8F #E4E75C #FF6A4D") },
  { id: "blueprint", name: "Blueprint", note: "Navy, sky accent", group: "webboard", seeds: seeds("#0B1630 #C9D6EA #7CC4FF #FFD166 #FF6B88") },
  { id: "tungsten", name: "Tungsten", note: "Warm, little blue", group: "webboard", seeds: seeds("#110D0B #DDD0C5 #F2A65A #7FD6C8 #FF4F6E") },
  { id: "graphite", name: "Graphite", note: "Quiet, almost grey", group: "webboard", seeds: seeds("#141517 #CED2D7 #9FB7CF #E2B44A #F25C5C") },
  { id: "daylight", name: "Daylight", note: "Cyberdeck in light", group: "webboard", seeds: seeds("#E9EDF3 #1B2332 #006D86 #915600 #BC1646") },
  { id: "paper", name: "Paper", note: "White, high contrast", group: "webboard", seeds: seeds("#FFFFFF #111418 #1F5FD1 #A35400 #CC1F3D") },
  { id: "fetcher-dark", name: "ColorFetcher", note: "The site's own colours", group: "colorfetcher", seeds: seeds("#161513 #FAF6F0 #3DD1A8 #FFB13D #FF4A77") },
  { id: "fetcher-light", name: "ColorFetcher", note: "The site's own colours", group: "colorfetcher", seeds: seeds("#FAF6F0 #1A1A1A #005FEB #985B00 #CC0034") },
  { id: "sunset-dark", name: "Sunset", note: "From the sample image", group: "colorfetcher", seeds: seeds("#292214 #FFEABA #FEC759 #BACFFF #FF96A6") },
  { id: "sunset-light", name: "Sunset", note: "From the sample image", group: "colorfetcher", seeds: seeds("#F8F6F2 #242119 #8F5F01 #0D57FF #CC001F") },
  { id: "ocean-dark", name: "Ocean", note: "From the sample image", group: "colorfetcher", seeds: seeds("#142629 #C9ECE6 #30C9DD #DDD19A #DD9AA6") },
  { id: "ocean-light", name: "Ocean", note: "From the sample image", group: "colorfetcher", seeds: seeds("#F2F8F7 #192324 #057485 #786928 #B43C52") },
  { id: "botanical-dark", name: "Botanical", note: "From the sample image", group: "colorfetcher", seeds: seeds("#252617 #FFD9CC #4BB073 #F67B2E #FF6A8E") },
  { id: "botanical-light", name: "Botanical", note: "From the sample image", group: "colorfetcher", seeds: seeds("#FFD9CC #241C19 #9C4007 #2C6844 #B01441") },
];

export const DEFAULT_ID = "cyberdeck";
export const DEFAULT_DARK = "cyberdeck";
export const DEFAULT_LIGHT = "daylight";

export const tokensOf = (t: Theme): Tokens => ({ ...derive(t.seeds), ...t.exact });
