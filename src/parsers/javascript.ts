import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { typescriptConfig } from "./typescript.js";
import type { TreeSitterLanguageConfig } from "./tree-sitter-parser.js";

// JS parser reuses TS extraction logic — AST structure is the same minus types.
// Metadata inherited from TS via spread; JS-specific test frameworks added.
export const javascriptConfig: TreeSitterLanguageConfig = {
  ...typescriptConfig,
  grammar: require("tree-sitter-javascript"),
  extensions: [".js", ".jsx"],
  testImportPrefixes: [...(typescriptConfig.testImportPrefixes || []), "mocha", "chai"],
  workspaceManifests: ["package.json"],
};
