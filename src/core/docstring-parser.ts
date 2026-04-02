import type { ParsedDocstring } from "../types/index.js";
import type { IDocstringParser } from "../types/interfaces.js";

export class DocstringParser implements IDocstringParser {
  parse(raw: string, kind: "function" | "method" | "class"): ParsedDocstring {
    return {
      raw,
      summary: this.extractSummary(raw),
      body: this.stripAnnotationFields(raw),
      deps: this.extractField(raw, "deps"),
      sideEffects: this.extractField(raw, "side_?effects"),
      tags: this.extractField(raw, "tags"),
      complexity: this.extractSingleField(raw, "complexity"),
      inherits: kind === "class" ? this.extractField(raw, "inherits") : undefined,
      state: kind === "class" ? this.extractField(raw, "state") : undefined,
      pattern: kind === "class" ? this.extractField(raw, "pattern") : undefined,
    };
  }

  private extractSummary(raw: string): string {
    // First sentence: up to first ". " or "\n\n" or end
    const match = raw.match(/^(.+?)(?:\.\s|\n\n|$)/s);
    return (match?.[1]?.trim() || raw.trim()).replace(/\.$/, "");
  }

  private extractField(raw: string, fieldPattern: string): string[] {
    // Supports: @deps, @dep, @tags, @tag, @side_effects, @sideEffects
    const pattern = new RegExp(`@${fieldPattern}?:\\s*(.+?)(?=\\n\\s*@|\\n\\s*$|$)`, "si");
    const match = raw.match(pattern);
    if (!match) return [];
    return match[1]
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  private stripAnnotationFields(raw: string): string {
    return raw
      .replace(/^\s*@\w+\s*:?\s*[^\n]*(?:\n(?!\s*@|\s*$)[^\n]*)*/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private extractSingleField(raw: string, fieldName: string): string | null {
    const pattern = new RegExp(`@${fieldName}:\\s*(.+?)(?=\\n\\s*@|\\n\\s*$|$)`, "si");
    return raw.match(pattern)?.[1]?.trim() || null;
  }
}
