import { z } from "zod";

const workspace = z.string().optional().describe(
  "Workspace path (e.g. 'backend', 'mobile'). Optional — omit to search all workspaces."
);

export const SemanticSearchSchema = z.object({
  query: z.string().min(1).describe("Natural language description of what you're looking for (e.g., 'payment processing', 'user authentication middleware', 'how orders are validated')"),
  workspace,
  scope: z.string().optional().describe("Limit search to a specific directory path (e.g., 'payments', 'domain/order'). Source root prefixes are automatically stripped. Dot notation supported (e.g., 'com.example.service'). Omit to search entire codebase."),
  top_k: z.number().int().min(1).max(100).default(10).describe("Number of results to return (1-100, default 10)"),
  tags_filter: z.array(z.string()).optional().describe("Only return functions with ALL of these @tags (AND logic). Tags come from docstring annotations."),
  side_effects_filter: z.array(z.string()).optional().describe("Only return functions with ANY of these side effects (OR logic). Values: database_read, database_write, external_api_call, modifies_state, sends_notification, file_io"),
});

export const ModuleSummarySchema = z.object({
  module: z.string().min(1).describe("Directory path relative to project root (e.g., 'payments', 'domain/order', 'src/components'). Returns all functions in this directory and subdirectories. Source root prefixes are automatically stripped. Dot notation is converted to path separators (e.g., 'com.example.service' → 'com/example/service')."),
  workspace,
  file: z.string().optional().describe("Focus on a single file within the module (e.g., 'checkout.py'). Omit to see the entire module."),
  detail: z.enum(["auto", "full", "compact", "files_only"]).default("auto").describe("Detail level: 'auto' adapts to module size (default), 'full' shows signatures+summary+tags, 'compact' shows signatures only, 'files_only' shows file list with function counts."),
});

export const FunctionSourceSchema = z.object({
  function: z.string().min(1).describe("Function name to look up. Supports: plain name ('processOrder'), class.method ('PaymentProcessor.refund'), or partial match."),
  workspace,
  module: z.string().optional().describe("Disambiguate when multiple functions share the same name (e.g., 'payments' to get payments/process.py::validate, not orders/validate)"),
  context_lines: z.number().int().min(0).max(50).default(0).describe("Number of lines to include before and after the function (0-50, default 0). Useful to see imports or related code."),
});

export const DependenciesSchema = z.object({
  function: z.string().min(1).describe("Function name to analyze (e.g., 'processOrder', 'PaymentService.charge')"),
  workspace,
  module: z.string().optional().describe("Disambiguate when multiple functions share the same name"),
});

export const ImpactAnalysisSchema = z.object({
  function: z.string().min(1).describe("Function you plan to change"),
  workspace,
  module: z.string().optional().describe("Disambiguate when multiple functions share the same name"),
  change_type: z.enum(["signature", "behavior", "removal"]).default("behavior").describe("Type of planned change: 'signature' (param/return type change — highest impact), 'behavior' (internal logic change — default), 'removal' (deleting the function)"),
});

export const StaleDocstringsSchema = z.object({
  workspace,
  scope: z.string().optional().describe("Limit check to a directory (e.g., 'payments', 'domain/order'). Source root prefixes are automatically stripped. Dot notation supported (e.g., 'com.example.service')."),
  check_type: z.enum(["all", "deps", "tags", "missing"]).default("all").describe("What to check: 'all' (default), 'deps' (only @deps accuracy), 'tags' (only missing @tags), 'missing' (only functions without any docstring)"),
});

export const ReindexSchema = z.object({
  workspace,
  files: z.array(z.string()).optional().describe("Specific files to reindex (e.g., ['src/payments/processor.ts']). Omit for full scan."),
  force: z.boolean().default(false).describe("Force full rebuild of index, embeddings, and graphs (default: false). Use if index seems corrupt."),
});

export const IndexStatusSchema = z.object({
  workspace: z.string().optional().describe("Workspace to check. Omit to see all workspaces."),
});
