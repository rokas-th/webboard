import type { CSSProperties } from "react";
import { passes } from "../../theme/checks";
import type { Hex } from "../../theme/colour";
import { schemeOf, type Tokens } from "../../theme/derive";
import { tokensOf, type Group, type Theme } from "../../theme/presets";
import { allThemes, type ThemeStore } from "../../theme/store";
import { useTheme } from "../../theme/ThemeContext";

declare module "react" {
  interface CSSProperties {
    [key: `--${string}`]: string | undefined;
  }
}

export const paint = (t: Tokens): CSSProperties => ({
  "--c-void": t.void,
  "--c-panel": t.panel,
  "--c-line": t.line,
  "--c-cyan": t.cyan,
  "--c-cyan-dim": t["cyan-dim"],
  "--c-amber": t.amber,
  "--c-magenta": t.magenta,
  "--c-text": t.text,
  "--c-heading": t.heading,
});

export const swatch = (c: Hex): CSSProperties => ({ "--c-swatch": c });

const GROUPS: readonly { group: Group; title: string }[] = [
  { group: "webboard", title: "WebBoard" },
  { group: "colorfetcher", title: "From colorfetcher.com" },
  { group: "mine", title: "Yours" },
];

const pressed = (s: ThemeStore, id: string): boolean => (s.mode === "fixed" ? s.active === id : s.dark === id || s.light === id);

const slotTags = (s: ThemeStore, id: string): readonly string[] =>
  s.mode === "system" ? [...(s.dark === id ? ["When dark"] : []), ...(s.light === id ? ["When light"] : [])] : [];

function Card(p: { theme: Theme; store: ThemeStore; edited: boolean; hover: boolean; onChoose(id: string): void; onPreview(id: string | null): void }) {
  const { theme, store } = p;
  const tokens = tokensOf(theme);
  const fails = !passes(theme.seeds, tokens);
  return (
    <button
      type="button"
      className="theme-card"
      aria-pressed={pressed(store, theme.id)}
      onClick={() => p.onChoose(theme.id)}
      onPointerEnter={p.hover ? () => p.onPreview(theme.id) : undefined}
      onFocus={p.hover ? () => p.onPreview(theme.id) : undefined}
      onBlur={p.hover ? () => p.onPreview(null) : undefined}
    >
      <span className="theme-preview" style={paint(tokens)} aria-hidden="true">
        <span className="theme-pv-side">
          <span className="theme-pv-line" />
          <span className="theme-pv-line" />
          <span className="theme-pv-line" />
        </span>
        <span className="theme-pv-done" />
        <span className="theme-pv-doing" />
        <span className="theme-pv-held" />
        <span className="theme-pv-today" />
        <span className="theme-pv-danger" />
      </span>
      <span className="theme-card-meta">
        <span className="theme-card-name">
          {theme.name}
          <span className="theme-card-scheme"> {schemeOf(theme.seeds.ground)}</span>
        </span>
        <span className="theme-card-note">{theme.note}</span>
        <span className="theme-card-tags">
          {slotTags(store, theme.id).map((tag) => (
            <span key={tag} className="theme-tag">
              {tag}
            </span>
          ))}
          {p.edited && <span className="theme-tag">Edited</span>}
          {fails && <span className="theme-tag theme-tag-bad">Fails checks</span>}
        </span>
      </span>
    </button>
  );
}

export function ThemeCards(p: { hover: boolean; edited: string | null; onChoose(id: string): void }) {
  const api = useTheme();
  const themes = allThemes(api.store);
  return (
    <div className="theme-cards" role="group" aria-label="Themes" onPointerLeave={p.hover ? () => api.preview(null) : undefined}>
      {GROUPS.map(({ group, title }) => {
        const members = themes.filter((t) => t.group === group);
        if (members.length === 0) return null;
        return [
          <h3 key={`${group}-title`} className="theme-group">
            {title}
          </h3>,
          ...members.map((t) => (
            <Card key={t.id} theme={t} store={api.store} edited={p.edited === t.id} hover={p.hover} onChoose={p.onChoose} onPreview={api.preview} />
          )),
        ];
      })}
    </div>
  );
}
