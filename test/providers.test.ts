import { describe, expect, test } from "bun:test";
import { HetznerProvider } from "../src/hetzner.ts";
import { OvhProvider } from "../src/ovh.ts";
import { createProvider } from "../src/providers.ts";

describe("createProvider", () => {
  test("builds the Hetzner adapter, which bills per started hour", () => {
    const p = createProvider({ kind: "hetzner", token: "t" });
    expect(p).toBeInstanceOf(HetznerProvider);
    expect(p.billing).toBe("per-started-hour");
  });

  test("builds the OVH adapter, which bills by runtime", () => {
    const p = createProvider({
      kind: "ovh",
      authUrl: "https://auth.cloud.ovh.us/v3",
      credentialId: "id",
      credentialSecret: "secret",
      region: "US-EAST-VA-1",
    });
    expect(p).toBeInstanceOf(OvhProvider);
    expect(p.billing).toBe("prorated");
  });

  test("passes the SSH key on to the adapter that creates servers", () => {
    const cfg = { kind: "ovh", authUrl: "https://a/v3", credentialId: "i", credentialSecret: "s", region: "R" } as const;
    expect(() => createProvider(cfg, { sshKeys: ["a", "b"] })).toThrow("exactly one");
  });
});
