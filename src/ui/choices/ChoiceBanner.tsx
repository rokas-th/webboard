import { useId } from "react";
import type { Choice } from "../../plan/choices";
import { bannerText } from "./describe";

export function ChoiceBanner(p: { choice: Choice; local: string; onChoose: () => void }) {
  const textId = useId();
  return (
    <div className="choice-banner">
      <span id={textId} className="banner-text">
        {bannerText(p.choice, p.local)}
      </span>
      <button type="button" className="button-small" aria-describedby={textId} onClick={p.onChoose}>
        Choose
      </button>
    </div>
  );
}
