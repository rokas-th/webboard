import type { Zoom } from "../state";

export const ZOOMS: readonly { zoom: Zoom; title: string; row: string }[] = [
  { zoom: "W", title: "Week", row: "Week" },
  { zoom: "M", title: "Month", row: "Month" },
  { zoom: "Q", title: "Quarter", row: "Quarter" },
  { zoom: "F", title: "Fit the whole plan", row: "Fit" },
];
