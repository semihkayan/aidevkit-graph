import type { AppContext } from "../types/interfaces.js";
import { resolveWorkspaceOrError, resolveFunctionOrError, textResponse } from "./tool-utils.js";

// Common utility calls that are noise in dependency analysis
const NOISE_TARGETS = new Set([
  // Python
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple",
  "isinstance", "issubclass", "hasattr", "getattr", "setattr", "super", "type", "id", "hash",
  "enumerate", "zip", "map", "filter", "sorted", "reversed", "max", "min", "sum", "any", "all",
  // JavaScript/TypeScript
  "console.log", "console.error", "console.warn", "console.info", "console.debug",
  "JSON.parse", "JSON.stringify", "Object.keys", "Object.values", "Object.entries",
  "Object.assign", "Object.freeze", "Object.create", "Array.from", "Array.isArray",
  "Math.floor", "Math.ceil", "Math.round", "Math.max", "Math.min", "Math.abs", "Math.random",
  "Promise.all", "Promise.resolve", "Promise.reject", "Promise.allSettled",
  "Date.now", "Number.parseInt", "Number.parseFloat", "String.fromCharCode",
  "Set.has", "Map.has", "Map.get", "Map.set",
  // Python qualified
  "os.path.join", "os.path.exists", "os.path.dirname", "os.path.basename",
  "os.path.abspath", "os.makedirs", "os.listdir", "os.remove",
  "json.loads", "json.dumps", "json.load", "json.dump",
  "logging.getLogger", "logging.info", "logging.debug", "logging.warning", "logging.error",
  "datetime.now", "datetime.utcnow", "datetime.strptime", "datetime.strftime",
  "time.time", "time.sleep",
  "re.match", "re.search", "re.sub", "re.compile", "re.findall",
  "copy.deepcopy", "copy.copy",
  // Go
  "fmt.Println", "fmt.Printf", "fmt.Sprintf", "fmt.Errorf", "fmt.Fprintf",
  "errors.New", "errors.Is", "errors.As", "errors.Unwrap",
  "context.Background", "context.TODO", "context.WithCancel", "context.WithTimeout",
  "strings.Contains", "strings.HasPrefix", "strings.HasSuffix", "strings.TrimSpace",
  "strings.Split", "strings.Join", "strings.Replace", "strings.ToLower", "strings.ToUpper",
  "strconv.Itoa", "strconv.Atoi", "strconv.FormatInt", "strconv.ParseInt",
  "filepath.Join", "filepath.Dir", "filepath.Base", "filepath.Ext",
  "sync.WaitGroup", "sync.Mutex", "sync.Once",
  "log.Println", "log.Printf", "log.Fatal", "log.Fatalf",
  "math.Max", "math.Min", "math.Abs",
  // Java stdlib
  "Instant.now", "Objects.requireNonNull", "Objects.hash", "Objects.equals",
  "UUID.randomUUID", "Duration.between", "Duration.ofSeconds", "Duration.ofMinutes",
  "Date.from", "BigDecimal.valueOf", "Optional.of", "Optional.ofNullable", "Optional.empty",
  "Collections.unmodifiableList", "Collections.singletonList",
  "Collections.emptyList", "Collections.emptyMap", "Stream.of",
  "ResponseEntity.ok", "ResponseEntity.status", "ResponseEntity.notFound",
  "Arrays.asList", "Arrays.stream", "Arrays.sort",
  "Integer.parseInt", "Integer.valueOf", "Long.parseLong", "Long.valueOf",
  "String.format", "String.valueOf", "Boolean.parseBoolean",
  // C#
  "Console.WriteLine", "Console.Write", "Console.ReadLine",
  "Convert.ToInt32", "Convert.ToString", "Convert.ToDouble",
  "Guid.NewGuid", "Guid.Parse", "Guid.Empty",
  "DateTime.Now", "DateTime.UtcNow", "DateTime.Parse", "DateTime.TryParse",
  "TimeSpan.FromSeconds", "TimeSpan.FromMinutes", "TimeSpan.FromHours",
  "Task.Run", "Task.WhenAll", "Task.WhenAny", "Task.FromResult", "Task.CompletedTask",
  "string.IsNullOrEmpty", "string.IsNullOrWhiteSpace", "string.Join", "string.Format",
  "Path.Combine", "Path.GetExtension", "Path.GetFileName",
  "File.ReadAllText", "File.WriteAllText", "File.Exists",
  "Enum.Parse", "Enum.TryParse",
  // Rust
  "println!", "eprintln!", "format!", "panic!", "todo!", "unimplemented!",
  "vec!", "assert!", "assert_eq!", "assert_ne!",
  "String.from", "String.new",
  "Vec.new", "Vec.with_capacity",
  "HashMap.new", "HashSet.new", "BTreeMap.new",
  "Box.new", "Arc.new", "Rc.new", "Mutex.new", "RwLock.new",
  "Option.unwrap", "Option.expect", "Option.map", "Option.and_then",
  "Result.unwrap", "Result.expect", "Result.map", "Result.map_err",
  "Ok", "Err", "Some", "None",
]);

// Common JS/TS built-in methods that appear as unresolved calls
const BUILTIN_METHODS = new Set([
  // JS/TS Array
  "map", "filter", "reduce", "forEach", "find", "some", "every", "includes",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "flat", "flatMap",
  "join", "sort", "reverse", "indexOf", "lastIndexOf", "fill", "copyWithin", "at",
  // JS/TS Map/Set/Iterables
  "entries", "values", "keys", "has", "get", "set", "delete", "add", "clear",
  // JS/TS String
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll",
  "match", "matchAll", "startsWith", "endsWith",
  "padStart", "padEnd", "repeat", "charAt", "charCodeAt", "substring", "toLowerCase", "toUpperCase",
  // JS/TS Object/General
  "toJSON", "assign", "create", "freeze", "from", "isArray",
  // JS/TS Promise
  "then", "catch", "finally",
  // Java common
  "orElse", "orElseGet", "orElseThrow", "isPresent", "ifPresent",
  "stream", "collect", "toList", "of", "copyOf",
  "equals", "hashCode", "compareTo", "toString", "valueOf", "getClass",
  "intValue", "longValue", "doubleValue", "floatValue",
  "name", "ordinal",
  // Python
  "append", "extend", "insert", "remove", "items", "update", "strip", "lstrip", "rstrip",
  "encode", "decode", "format", "upper", "lower", "capitalize", "title",
  "count", "index", "copy", "pop",
  // Go (methods)
  "Error", "String", "Close", "Read", "Write", "Len", "Cap",
  "Lock", "Unlock", "RLock", "RUnlock", "Wait", "Signal", "Broadcast",
  "Done", "Err", "Value", "Deadline",
  // C#
  "Any", "All", "Where", "Select", "SelectMany", "FirstOrDefault", "First",
  "SingleOrDefault", "Single", "Count", "Sum", "Average", "OrderBy", "OrderByDescending",
  "GroupBy", "Distinct", "Skip", "Take", "ToArray",
  "Add", "Remove", "Contains", "ContainsKey", "TryGetValue",
  "Append", "Insert", "RemoveAt", "AddRange",
  "GetAwaiter", "GetResult", "ConfigureAwait",
  "Dispose",
  // Rust
  "unwrap", "expect", "unwrap_or", "unwrap_or_else", "unwrap_or_default",
  "map", "and_then", "or_else", "ok_or", "ok_or_else",
  "iter", "into_iter", "collect", "for_each",
  "len", "is_empty", "contains", "insert", "remove", "push", "pop",
  "clone", "to_string", "to_owned", "as_ref", "as_mut",
  "lock", "read", "write", "try_lock",
  "into", "from", "try_into", "try_from",
]);

// Stdlib namespace patterns — catch entire modules without listing each method
const NOISE_PATTERNS = [
  // Loggers (all languages)
  /^(logger|log|logging|console|slog|zap|logrus|Log|_logger|_log|ILogger)\.\w+$/i,
  // Python stdlib modules
  /^(os|os\.path|sys|io|pathlib|typing|abc|dataclasses|functools|itertools|collections|math|random|shutil|glob|subprocess|tempfile|unittest|pytest)\.\w+$/,
  // Go stdlib packages
  /^(fmt|errors|context|strings|strconv|filepath|sync|log|math|sort|io|bytes|os|time|reflect|regexp|testing|net|http|encoding)\.\w+$/,
  // Java stdlib classes
  /^(System|Math|Arrays|Collections|Objects|Optional|Stream|Collectors|Integer|Long|Double|Float|String|Boolean|Character|BigDecimal|BigInteger|UUID|Instant|Duration|LocalDate|LocalDateTime|ZonedDateTime|Date|TimeUnit|Pattern|Matcher|StringBuilder|StringBuffer|Thread|Executors|CompletableFuture|AtomicInteger|AtomicLong|ResponseEntity|HttpStatus)\.\w+$/,
  // C# stdlib classes
  /^(Console|Convert|Guid|DateTime|DateTimeOffset|TimeSpan|Task|Math|Enum|Path|File|Directory|Regex|StringBuilder|Activator|GC|Monitor|Interlocked|CancellationToken|JsonSerializer|Environment)\.\w+$/,
  // Rust std types (qualified)
  /^(String|Vec|HashMap|HashSet|BTreeMap|BTreeSet|Box|Arc|Rc|Mutex|RwLock|Cell|RefCell|Option|Result|Cow|Pin)\.\w+$/,
  // Test assertions (all frameworks)
  /^(Assert|Assertions|Expect|expect|assert|assertThat|verify|mock|when|given)\.\w+$/i,
];

function isNoisyCall(target: string): boolean {
  if (NOISE_TARGETS.has(target)) return true;
  if (NOISE_PATTERNS.some(p => p.test(target))) return true;
  // Built-in method calls: x.map, x.filter, x.push, etc.
  const method = target.split(".").pop();
  if (method && target.includes(".") && BUILTIN_METHODS.has(method)) return true;
  return false;
}

/**
 * Collapse fluent method chains into one entry per chain.
 * Java/TS chains like Jwts.builder().subject().claim() produce a separate
 * call_expression for each .method(). Keep only the outermost per root per line.
 */
function deduplicateChains<T extends { target: string; line: number }>(calls: T[]): T[] {
  // Group by line + root object (first segment before "." or "(")
  const byLineAndRoot = new Map<string, T>();
  for (const c of calls) {
    const root = c.target.split(".")[0].split("(")[0];
    const key = `${c.line}:${root}`;
    const existing = byLineAndRoot.get(key);
    // Keep the longest target (outermost chain call)
    if (!existing || c.target.length > existing.target.length) {
      byLineAndRoot.set(key, c);
    }
  }

  const result = Array.from(byLineAndRoot.values());

  // Simplify long chain targets: "Jwts.builder().subject()...compact" → "Jwts.compact"
  for (const c of result) {
    if (c.target.includes("(")) {
      const firstObj = c.target.split(".")[0].split("(")[0];
      const parts = c.target.split(".");
      const lastMethod = parts[parts.length - 1].split("(")[0];
      if (firstObj && lastMethod && firstObj !== lastMethod) {
        c.target = `${firstObj}.${lastMethod}`;
      }
    }
  }

  return result;
}

function matchesDep(target: string, dep: string): boolean {
  // Direct match
  if (target.includes(dep) || dep.includes(target)) return true;
  // self.x.method matches module.method (e.g., self.repository.find_by_code ~ coupon_repository.find_by_code)
  const targetMethod = target.split(".").pop();
  const depMethod = dep.split(".").pop();
  if (targetMethod && depMethod && targetMethod === depMethod) return true;
  return false;
}

export async function handleDependencies(
  args: { function: string; workspace?: string; module?: string },
  ctx: AppContext
) {
  const resolved = resolveWorkspaceOrError(ctx, args.workspace);
  if ("error" in resolved) return resolved.error;
  const ws = resolved.ws;

  const fn = resolveFunctionOrError(ws, args.function, args.module);
  if ("error" in fn) return fn.error;
  const record = fn.record;
  const entry = ws.callGraph.getEntry(record.id);
  const docDeps = record.docstring?.deps || [];

  const confirmed: any[] = [];
  const astOnly: any[] = [];
  const unresolvedCalls: any[] = [];
  const docstringOnly: string[] = [];

  if (entry) {
    // Pre-filter noise and collapse fluent chains before categorization
    const calls = deduplicateChains(
      entry.calls.filter(c => !isNoisyCall(c.target))
    );

    for (const call of calls) {

      if (call.resolvedId) {
        const targetRecord = ws.index.getById(call.resolvedId);
        const inDocDeps = docDeps.some(d => matchesDep(call.target, d));

        if (inDocDeps) {
          confirmed.push({
            target: call.target,
            file: targetRecord?.filePath || call.resolvedFile,
            line: call.line,
            source: "confirmed",
          });
        } else {
          astOnly.push({
            target: call.target,
            file: targetRecord?.filePath || call.resolvedFile,
            line: call.line,
            resolved: true,
          });
        }
      } else {
        const isSelfDirect = call.target.startsWith("self.") || call.target.startsWith("this.");

        if (isSelfDirect) {
          // Distinguish: this.method() (own method) vs this.field.method() (delegation)
          const parts = call.target.split(".");
          if (parts.length === 2) {
            // this.method() — own method, skip unless in @deps
            const inDocDeps = docDeps.some(d => matchesDep(call.target, d));
            if (inDocDeps) {
              confirmed.push({ target: call.target, file: record.filePath, line: call.line, source: "confirmed" });
            }
            continue;
          }
          // this.field.method() (3+ parts) — delegation to injected service, show it
          const delegateTarget = parts.slice(1).join(".");  // "vectorDb.vectorSearch"
          const inDocDeps = docDeps.some(d => matchesDep(delegateTarget, d));
          if (inDocDeps) {
            confirmed.push({ target: delegateTarget, file: null, line: call.line, source: "confirmed" });
          } else {
            astOnly.push({ target: delegateTarget, line: call.line, resolved: false, note: "Delegation via injected dependency" });
          }
          continue;
        }

        // Check if this looks like a service delegation (obj.method pattern with 2+ segments)
        const parts = call.target.split(".");
        if (parts.length >= 2 && !isNoisyCall(call.target)) {
          astOnly.push({ target: call.target, line: call.line, resolved: false, note: "Unresolved delegation" });
        } else if (!isNoisyCall(call.target)) {
          unresolvedCalls.push({
            target: call.target,
            line: call.line,
            note: "Could not resolve. May be dynamic dispatch or external call.",
          });
        }
      }
    }

    // @deps not found in AST
    for (const dep of docDeps) {
      const foundInAst = entry.calls.some(c => matchesDep(c.target, dep));
      if (!foundInAst) docstringOnly.push(dep);
    }
  }

  return textResponse({
    function: record.name,
    file: record.filePath,
    calls: confirmed,
    ...(astOnly.length > 0 ? { ast_only: astOnly } : {}),
    ...(docstringOnly.length > 0 ? { docstring_only: docstringOnly } : {}),
    ...(unresolvedCalls.length > 0 ? { unresolved: unresolvedCalls } : {}),
    caveat: "Static analysis only. Dynamic dispatch, callbacks, and inherited methods are not captured.",
  });
}
