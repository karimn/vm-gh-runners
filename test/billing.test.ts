import { describe, expect, test } from "bun:test";
import { ageMinutes, shouldReap } from "../src/billing.ts";

const created = new Date("2026-01-01T00:00:00Z");
const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);

describe("shouldReap", () => {
  test("idle server is left alone early in the paid hour", () => {
    expect(shouldReap({ now: at(10), createdAt: created, busy: false })).toBe(false);
    expect(shouldReap({ now: at(49.9), createdAt: created, busy: false })).toBe(false);
  });

  test("idle server is reaped in the last minutes of the paid hour", () => {
    expect(shouldReap({ now: at(50), createdAt: created, busy: false })).toBe(true);
    expect(shouldReap({ now: at(59.9), createdAt: created, busy: false })).toBe(true);
  });

  test("busy server is never reaped", () => {
    expect(shouldReap({ now: at(55), createdAt: created, busy: true })).toBe(false);
  });

  test("the window repeats every paid hour", () => {
    expect(shouldReap({ now: at(60 + 20), createdAt: created, busy: false })).toBe(false);
    expect(shouldReap({ now: at(60 + 55), createdAt: created, busy: false })).toBe(true);
    expect(shouldReap({ now: at(120 + 51), createdAt: created, busy: false })).toBe(true);
  });

  test("the hour boundary itself starts a fresh, non-reapable hour", () => {
    expect(shouldReap({ now: at(60), createdAt: created, busy: false })).toBe(false);
  });

  test("window start is configurable", () => {
    const input = { now: at(40), createdAt: created, busy: false };
    expect(shouldReap(input)).toBe(false);
    expect(shouldReap({ ...input, windowStartMinute: 30 })).toBe(true);
  });

  test("a creation time in the future is never reapable", () => {
    expect(shouldReap({ now: created, createdAt: at(30), busy: false })).toBe(false);
    expect(ageMinutes(created, at(30))).toBe(0);
  });
});

describe("shouldReap on a provider billed by runtime", () => {
  const prorated = { createdAt: created, billing: "prorated" } as const;

  test("an idle server is reaped at any age, with no paid hour to wait out", () => {
    for (const m of [0, 1, 10, 49.9, 60, 80, 125]) {
      expect(shouldReap({ ...prorated, now: at(m), busy: false })).toBe(true);
    }
  });

  test("a busy server is still never reaped", () => {
    expect(shouldReap({ ...prorated, now: at(30), busy: true })).toBe(false);
  });

  test("the window start is ignored", () => {
    expect(shouldReap({ ...prorated, now: at(5), busy: false, windowStartMinute: 55 })).toBe(true);
  });

  test("per-started-hour stays the default", () => {
    expect(shouldReap({ now: at(5), createdAt: created, busy: false })).toBe(false);
    expect(shouldReap({ now: at(5), createdAt: created, busy: false, billing: "per-started-hour" })).toBe(false);
  });
});
