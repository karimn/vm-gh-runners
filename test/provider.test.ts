import { describe, expect, test } from "bun:test";
import { serverLabels } from "../src/provider.ts";

describe("serverLabels", () => {
  test("encodes owner/name without a slash", () => {
    expect(serverLabels("ci", "karimn/sia")).toEqual({ pool: "ci", repo: "karimn_sia" });
  });

  test("keeps different repos distinct", () => {
    expect(serverLabels("ci", "karimn/sia").repo).not.toBe(serverLabels("ci", "karimn/pioneer").repo);
    expect(serverLabels("ci", "a-b/c").repo).not.toBe(serverLabels("ci", "a/b-c").repo);
  });
});
