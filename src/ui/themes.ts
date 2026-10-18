/** A colour theme. Its colours live in App.css under `:root[data-theme="<id>"]`. */
export interface ThemeInfo {
  id: string;
  name: string;
  dark: boolean;
  /** Window, panel and accent colours, for the picker's preview. */
  swatch: [string, string, string];
}

/** "system" follows the OS light/dark setting with the Light and Dark themes. */
export type ThemeChoice = "system" | string;

export const THEMES: ThemeInfo[] = [
  { id: "light", name: "Light", dark: false, swatch: ["#e9ecf1", "#ffffff", "#2f6fde"] },
  { id: "lavender", name: "Lavender", dark: false, swatch: ["#ebe7f6", "#fcfbff", "#7c4dcc"] },
  { id: "solarized-light", name: "Solarized Light", dark: false, swatch: ["#eee8d5", "#fdf6e3", "#268bd2"] },
  { id: "dark", name: "Dark", dark: true, swatch: ["#0f1013", "#1c1e23", "#5a8ef2"] },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, swatch: ["#00212b", "#002b36", "#2aa1e8"] },
  { id: "nord", name: "Nord", dark: true, swatch: ["#242933", "#2e3440", "#88c0d0"] },
  { id: "dracula", name: "Dracula", dark: true, swatch: ["#1e1f29", "#282a36", "#bd93f9"] },
];

/** The theme to apply for a saved choice; unknown ids fall back to following the system. */
export function resolveTheme(choice: ThemeChoice): ThemeInfo | null {
  return THEMES.find((t) => t.id === choice) ?? null;
}
