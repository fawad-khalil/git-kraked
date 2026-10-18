/** A colour theme. Its colours live in App.css under `:root[data-theme="<id>"]`. */
export interface ThemeInfo {
  id: string;
  name: string;
  dark: boolean;
  /** Window, panel and accent colours, for the picker's preview. */
  swatch: [string, string, string];
}

/** The toolbar toggle. "system" switches between the light and dark theme with the OS. */
export type ThemeMode = "system" | "light" | "dark";

export const THEMES: ThemeInfo[] = [
  { id: "light", name: "Light", dark: false, swatch: ["#e9ecf1", "#ffffff", "#2f6fde"] },
  { id: "lavender", name: "Lavender", dark: false, swatch: ["#ebe7f6", "#fcfbff", "#7c4dcc"] },
  { id: "solarized-light", name: "Solarized Light", dark: false, swatch: ["#eee8d5", "#fdf6e3", "#268bd2"] },
  { id: "dark", name: "Dark", dark: true, swatch: ["#0f1013", "#1c1e23", "#5a8ef2"] },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, swatch: ["#00212b", "#002b36", "#2aa1e8"] },
  { id: "nord", name: "Nord", dark: true, swatch: ["#242933", "#2e3440", "#88c0d0"] },
  { id: "dracula", name: "Dracula", dark: true, swatch: ["#1e1f29", "#282a36", "#bd93f9"] },
];

/** The saved light or dark theme; an unknown id (or one of the wrong kind) gives the default. */
export function pickTheme(id: string, dark: boolean): ThemeInfo {
  return (
    THEMES.find((t) => t.id === id && t.dark === dark) ??
    THEMES.find((t) => t.id === (dark ? "dark" : "light"))!
  );
}

/** The theme to show for the toggle, the chosen light and dark themes, and the OS setting. */
export function appliedTheme(mode: ThemeMode, lightId: string, darkId: string, systemDark: boolean): ThemeInfo {
  const dark = mode === "dark" || (mode !== "light" && systemDark);
  return pickTheme(dark ? darkId : lightId, dark);
}
