import * as vscode from "vscode";

/**
 * Estilo visual de Alfred. El ajuste `opencodeAgents.theme` decide entre dos
 * paletas: `alfred` (HUD oscuro, el de siempre) y `manoli` (grises claros y
 * tonos pastel). Este módulo no guarda estado: solo lee el ajuste y arma el
 * HTML de las hojas y del script que lo aplican en cada webview.
 */

export type ThemeId = "alfred" | "manoli";

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  description: string;
}

export const THEMES: readonly ThemeInfo[] = [
  { id: "alfred", label: "Tema Alfred", description: "HUD oscuro, el aspecto de siempre." },
  { id: "manoli", label: "Tema Manoli", description: "Grises claros y tonos pastel." },
];

export function isThemeId(value: unknown): value is ThemeId {
  return value === "alfred" || value === "manoli";
}

/** Tema vigente según el ajuste; un valor raro cae a `alfred`. */
export function currentTheme(): ThemeId {
  const value = vscode.workspace.getConfiguration("opencodeAgents").get<unknown>("theme");
  return isThemeId(value) ? value : "alfred";
}

/** Hojas en el orden obligatorio: los dos temas, la base, la UI, el panel y sus extras. */
export function themeLinks(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  panelCss: string[],
  extraCss: string[] = []
): string {
  const media = (name: string): vscode.Uri =>
    vscode.Uri.joinPath(extensionUri, "media", name);
  const sheets = [
    "themes/alfred.css",
    "themes/manoli.css",
    "theme/base.css",
    "theme/ui.css",
    ...panelCss,
    ...extraCss,
  ];
  return sheets
    .map((name) => `<link href="${webview.asWebviewUri(media(name))}" rel="stylesheet" />`)
    .join("\n");
}

/** Script que pone `data-theme` en el `<body>` cuando el host avisa del cambio. */
export function themeScript(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  nonce: string
): string {
  const uri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "theme.js")
  );
  return `<script nonce="${nonce}" src="${uri}"></script>`;
}
