import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type GlyphState = { streaming: boolean };

// The stock editor frames the text with full-width rules in the theme's border
// color. Flat mode paints them quiet (borderMuted) and spends the left padding
// on a prompt glyph that mirrors the tool-status language: accent ❯ when idle,
// dim ◐ while the agent streams (input will queue/steer).
export class FlatEditor extends CustomEditor {
  private glyphState: GlyphState;
  private paint: (color: string, text: string) => string;

  constructor(tui: any, editorTheme: any, keybindings: any, glyphState: GlyphState, paint: (color: string, text: string) => string) {
    super(tui, { ...editorTheme, borderColor: (s: string) => paint("borderMuted", s) }, keybindings, { paddingX: 2 });
    this.glyphState = glyphState;
    this.paint = paint;
  }

  render(width: number): string[] {
    const rows = super.render(width);
    const first = rows.findIndex((row) => row.startsWith("  "));
    if (first >= 0) {
      const glyph = this.glyphState.streaming ? this.paint("dim", "◐") : this.paint(this.focused ? "accent" : "dim", "❯");
      rows[first] = `${glyph} ${rows[first].slice(2)}`;
    }
    return rows;
  }
}

export default function inputExtension(pi: ExtensionAPI) {
  const glyphState: GlyphState = { streaming: false };
  pi.on("agent_start", () => {
    glyphState.streaming = true;
  });
  pi.on("agent_end", () => {
    glyphState.streaming = false;
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const paint = (color: string, text: string) => (ctx.ui.theme as any).fg(color, text);
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new FlatEditor(tui, editorTheme, keybindings, glyphState, paint));
  });
}
