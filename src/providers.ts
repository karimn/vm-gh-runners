import type { ProviderConfig } from "./config.ts";
import { HetznerProvider } from "./hetzner.ts";
import { OvhProvider } from "./ovh.ts";
import type { Provider } from "./provider.ts";

/**
 * The one place a configured provider name becomes an adapter. `sshKeys` is only
 * needed by `ensure`, which creates servers; reap and release never do.
 */
export const createProvider = (
  cfg: ProviderConfig,
  options: { readonly sshKeys?: readonly string[] } = {},
): Provider => {
  switch (cfg.kind) {
    case "hetzner":
      return new HetznerProvider({ token: cfg.token, sshKeys: options.sshKeys });
    case "ovh":
      return new OvhProvider({
        authUrl: cfg.authUrl,
        credentialId: cfg.credentialId,
        credentialSecret: cfg.credentialSecret,
        region: cfg.region,
        sshKeys: options.sshKeys,
      });
  }
};
