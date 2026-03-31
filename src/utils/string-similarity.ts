/**
 * Decomposes a camelCase, PascalCase, snake_case, or CONSTANT_CASE identifier
 * into individual word segments.
 *
 * Examples:
 *   "GetStreakInfoService" → ["Get", "Streak", "Info", "Service"]
 *   "process_payment"     → ["process", "payment"]
 *   "HTTPSConnection"     → ["HTTPS", "Connection"]
 */
export function decomposeIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1\0$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
    .replace(/_/g, "\0")
    .split("\0")
    .filter(s => s.length > 0);
}

/**
 * Jaro-Winkler similarity between two strings. Returns 0–1 (1 = identical).
 * Prefix bonus rewards strings that share a common beginning.
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;

  const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);

  const s1Matches = new Array<boolean>(len1).fill(false);
  const s2Matches = new Array<boolean>(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(i + matchWindow + 1, len2);
    for (let j = lo; j < hi; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

  // Winkler: boost for common prefix (up to 4 chars)
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(len1, len2));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return Math.min(1.0, jaro + prefix * 0.1 * (1 - jaro));
}

export interface FindSimilarOptions {
  /** "identifier" for camelCase/snake_case decomposition, "path" for "/" splitting */
  mode?: "identifier" | "path";
  /** Minimum score to include (default 0.78) */
  threshold?: number;
  /** Max suggestions to return (default 5) */
  maxResults?: number;
}

/**
 * Finds the most similar strings from a candidate set using Jaro-Winkler similarity
 * with segment-level matching. Returns candidates sorted by score, original case preserved.
 */
export function findSimilar(
  query: string,
  candidates: Iterable<string>,
  options?: FindSimilarOptions,
): string[] {
  if (query.length < 2) return [];

  const mode = options?.mode ?? "identifier";
  const threshold = options?.threshold ?? 0.78;
  const maxResults = options?.maxResults ?? 5;

  const queryLower = query.toLowerCase();
  const querySegments =
    mode === "path"
      ? queryLower.split("/").filter(s => s.length > 0)
      : decomposeIdentifier(query).map(s => s.toLowerCase());

  const scored: Array<{ name: string; score: number }> = [];

  for (const candidate of candidates) {
    const candidateLower = candidate.toLowerCase();

    // Fast path: substring match
    if (candidateLower.includes(queryLower) || queryLower.includes(candidateLower)) {
      scored.push({ name: candidate, score: 0.95 });
      continue;
    }

    // Full-string Jaro-Winkler
    const fullJW = jaroWinkler(queryLower, candidateLower);

    // Segment-level Jaro-Winkler
    let segmentScore = 0;
    if (querySegments.length > 0) {
      const candidateSegments =
        mode === "path"
          ? candidateLower.split("/").filter(s => s.length > 0)
          : decomposeIdentifier(candidate).map(s => s.toLowerCase());

      if (candidateSegments.length > 0) {
        let sum = 0;
        for (const qs of querySegments) {
          let best = 0;
          for (const cs of candidateSegments) {
            const sim = jaroWinkler(qs, cs);
            if (sim > best) best = sim;
          }
          sum += best;
        }
        segmentScore = sum / querySegments.length;
      }
    }

    const score = Math.max(fullJW, segmentScore);
    if (score >= threshold) {
      scored.push({ name: candidate, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(s => s.name);
}
