import { describe, it, expect } from "vitest";
import { decomposeIdentifier, jaroWinkler, findSimilar } from "./string-similarity.js";

describe("decomposeIdentifier", () => {
  it("splits camelCase", () => {
    expect(decomposeIdentifier("getStreak")).toEqual(["get", "Streak"]);
  });

  it("splits PascalCase", () => {
    expect(decomposeIdentifier("GetStreakInfoService")).toEqual([
      "Get", "Streak", "Info", "Service",
    ]);
  });

  it("splits snake_case", () => {
    expect(decomposeIdentifier("process_payment")).toEqual(["process", "payment"]);
  });

  it("splits CONSTANT_CASE with trailing word", () => {
    expect(decomposeIdentifier("HTTPSConnection")).toEqual(["HTTPS", "Connection"]);
  });

  it("returns single element for flat name", () => {
    expect(decomposeIdentifier("streak")).toEqual(["streak"]);
  });

  it("handles empty string", () => {
    expect(decomposeIdentifier("")).toEqual([]);
  });
});

describe("jaroWinkler", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaroWinkler("abc", "abc")).toBe(1.0);
  });

  it("returns 0.0 when either is empty", () => {
    expect(jaroWinkler("", "foo")).toBe(0.0);
    expect(jaroWinkler("foo", "")).toBe(0.0);
  });

  it("scores high for 1-char deletion typo (securty → security)", () => {
    expect(jaroWinkler("securty", "security")).toBeGreaterThanOrEqual(0.95);
  });

  it("scores high for 1-char deletion typo (strek → streak)", () => {
    expect(jaroWinkler("strek", "streak")).toBeGreaterThanOrEqual(0.93);
  });

  it("scores low for unrelated strings (contest → security)", () => {
    expect(jaroWinkler("contest", "security")).toBeLessThanOrEqual(0.60);
  });

  it("is symmetric", () => {
    const a = jaroWinkler("strek", "streak");
    const b = jaroWinkler("streak", "strek");
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });

  it("scores higher with common prefix (Winkler boost)", () => {
    // "secur" prefix shared → higher than strings with no prefix overlap
    const withPrefix = jaroWinkler("securty", "security");
    const noPrefix = jaroWinkler("xecurty", "security");
    expect(withPrefix).toBeGreaterThan(noPrefix);
  });
});

describe("findSimilar", () => {
  describe("identifier mode", () => {
    const candidates = [
      "GetStreakInfoService",
      "PaymentProcessor",
      "SecurityManager",
      "OrderService",
    ];

    it("finds substring match (getStreak → GetStreakInfoService)", () => {
      const result = findSimilar("getStreak", candidates);
      expect(result[0]).toBe("GetStreakInfoService");
    });

    it("finds via segment JW (strekService → GetStreakInfoService)", () => {
      const result = findSimilar("strekService", candidates);
      expect(result).toContain("GetStreakInfoService");
    });

    it("finds via full-string JW (securty → SecurityManager)", () => {
      const result = findSimilar("securty", ["security", "payments", "orders"]);
      expect(result[0]).toBe("security");
    });

    it("returns empty for unrelated query", () => {
      const result = findSimilar("contest", ["security", "payments", "orders"]);
      expect(result).toEqual([]);
    });

    it("respects maxResults", () => {
      const many = Array.from({ length: 20 }, (_, i) => `streakVariant${i}`);
      const result = findSimilar("streak", many, { maxResults: 3 });
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it("preserves original case in results", () => {
      const result = findSimilar("getstreak", ["GetStreakInfoService"]);
      expect(result[0]).toBe("GetStreakInfoService");
    });
  });

  describe("path mode", () => {
    it("finds typo in path segment (strek → com/wordbox/streak/domain)", () => {
      const result = findSimilar("strek", ["com/wordbox/streak/domain", "payments"], {
        mode: "path",
      });
      expect(result[0]).toBe("com/wordbox/streak/domain");
    });

    it("finds full-string JW match (securty → security)", () => {
      const result = findSimilar("securty", ["security", "payments/stripe"], {
        mode: "path",
      });
      expect(result[0]).toBe("security");
    });
  });

  describe("edge cases", () => {
    it("returns empty for empty query", () => {
      expect(findSimilar("", ["foo", "bar"])).toEqual([]);
    });

    it("returns empty for single-char query", () => {
      expect(findSimilar("a", ["abc", "def"])).toEqual([]);
    });

    it("handles empty candidates", () => {
      expect(findSimilar("test", [])).toEqual([]);
    });

    it("accepts Set as candidates", () => {
      const result = findSimilar("securty", new Set(["security", "payments"]));
      expect(result[0]).toBe("security");
    });

    it("exact match appears first", () => {
      const result = findSimilar("security", ["payments", "security", "orders"]);
      expect(result[0]).toBe("security");
    });
  });
});
