/**
 * First-boot setup for a runner VM, as cloud-init user-data. Installs Docker,
 * the GitHub Actions runner distribution and its dependencies, and creates the
 * unprivileged `runner` user. It registers nothing: registration happens later
 * over SSH, so no GitHub token ever appears here. User-data is readable from
 * inside the VM without authentication, so keep it that way.
 */

/** Shared with the registrar so the two cannot drift apart. */
export const DEFAULT_RUNNER_USER = "runner";
export const DEFAULT_TEMPLATE_DIR = "/opt/actions-runner";
/** Written as the setup script's last step, so it exists only if every step succeeded. */
export const READY_FILE = "/var/lib/vm-gh-runners/ready";

export interface UserDataOptions {
  /** `latest`, or an exact version such as `2.321.0` (recommended, for repeatability). */
  readonly runnerVersion?: string;
  /** Extra apt packages the jobs need. */
  readonly extraPackages?: readonly string[];
}

const VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/;

const BASE_PACKAGES = ["ca-certificates", "curl", "git", "jq", "tar", "unzip", "docker.io"];

const runnerVersionSnippet = (version: string): string =>
  version === "latest"
    ? `RUNNER_VERSION="$(curl -fsSL --retry 5 https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')"`
    : `RUNNER_VERSION=${version}`;

const setupScript = (opts: Required<UserDataOptions>): string => `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# unattended-upgrades often holds the apt lock during first boot; wait for it.
APT="apt-get -o DPkg::Lock::Timeout=300 -y"
$APT update
$APT install ${[...BASE_PACKAGES, ...opts.extraPackages].join(" ")}
systemctl enable --now docker

id ${DEFAULT_RUNNER_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${DEFAULT_RUNNER_USER}
usermod -aG docker ${DEFAULT_RUNNER_USER}
echo '${DEFAULT_RUNNER_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${DEFAULT_RUNNER_USER}
chmod 0440 /etc/sudoers.d/${DEFAULT_RUNNER_USER}
visudo -cf /etc/sudoers.d/${DEFAULT_RUNNER_USER}

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
${runnerVersionSnippet(opts.runnerVersion)}
rm -rf ${DEFAULT_TEMPLATE_DIR}
mkdir -p ${DEFAULT_TEMPLATE_DIR}
curl -fsSL --retry 5 "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-\${ARCH}-\${RUNNER_VERSION}.tar.gz" | tar -xz -C ${DEFAULT_TEMPLATE_DIR}
${DEFAULT_TEMPLATE_DIR}/bin/installdependencies.sh

install -d /var/lib/vm-gh-runners
touch ${READY_FILE}
`;

/** cloud-init user-data (`#cloud-config`) that prepares a fresh server to host runners. */
export const buildUserData = (options: UserDataOptions = {}): string => {
  const opts = {
    runnerVersion: options.runnerVersion ?? "latest",
    extraPackages: options.extraPackages ?? [],
  };
  if (opts.runnerVersion !== "latest" && !VERSION.test(opts.runnerVersion)) {
    throw new Error(`runnerVersion must be "latest" or like 2.321.0, got "${opts.runnerVersion}"`);
  }
  for (const p of opts.extraPackages) {
    if (!PACKAGE.test(p)) throw new Error(`invalid package name "${p}"`);
  }

  const indented = setupScript(opts)
    .trimEnd()
    .split("\n")
    .map((line) => (line === "" ? "" : `      ${line}`))
    .join("\n");

  return `#cloud-config
ssh_pwauth: false
write_files:
  - path: /opt/vm-gh-runners/setup.sh
    permissions: '0755'
    content: |
${indented}
runcmd:
  - [bash, /opt/vm-gh-runners/setup.sh]
`;
};
