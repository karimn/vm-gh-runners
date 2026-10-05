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

# A CI VM never upgrades itself (DESIGN.md "No automatic upgrades"). The stock
# image's overdue apt-daily-upgrade.timer fires in the VM's first hour; the
# upgrade re-executes systemd and restarts services, the runners and containerd
# among them, killing every running job. This must precede the runner install.
install -d /etc/needrestart/conf.d
cat > /etc/needrestart/conf.d/50-vgr.conf <<'EOF'
# vm-gh-runners: list services that need a restart, never restart them.
$nrconf{restart} = 'l';
EOF
export NEEDRESTART_MODE=l
# 99- so it sorts after, and overrides, the image's 20auto-upgrades.
cat > /etc/apt/apt.conf.d/99-vgr-no-auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Unattended-Upgrade "0";
EOF
# Units may be missing on some images; that is fine, so these must not fail.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer || true
systemctl mask apt-daily.service apt-daily-upgrade.service unattended-upgrades.service || true
systemctl stop apt-daily.service apt-daily-upgrade.service unattended-upgrades.service || true
# The units use KillMode=process, so a stop can leave unattended-upgrade or
# dpkg running on its own. Let it finish rather than kill it mid-install.
UPGRADING='/usr/bin/unattended-upgrade|apt\\.systemd\\.daily|/usr/bin/dpkg '
for _ in $(seq 450); do
  pgrep -f "$UPGRADING" >/dev/null || break
  sleep 2
done
if pgrep -f "$UPGRADING" >/dev/null; then
  echo "an automatic upgrade was still running after 15 minutes" >&2
  exit 1
fi
dpkg --configure -a

# Something else may still hold the apt lock during first boot; wait for it.
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

  // disable_root: false makes the injected key log in as root. The registrar
  // connects as root, which Hetzner allows by default; OVH's stock images
  // instead restrict root's key to a "log in as ubuntu" stub unless told not to.
  return `#cloud-config
ssh_pwauth: false
disable_root: false
write_files:
  - path: /opt/vm-gh-runners/setup.sh
    permissions: '0755'
    content: |
${indented}
runcmd:
  - [bash, /opt/vm-gh-runners/setup.sh]
`;
};
