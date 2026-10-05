/**
 * First-boot setup for a runner VM, as cloud-init user-data. Installs Docker,
 * the GitHub Actions runner distribution and its dependencies, and creates the
 * unprivileged `runner` user. It registers nothing: registration happens later
 * over SSH, so no GitHub token ever appears here. User-data is readable from
 * inside the VM without authentication, so keep it that way.
 *
 * The same script also boots a VM from an image made by `build-image`: it
 * detects BAKED_FILE and then skips what the image already holds.
 */

/** Shared with the registrar so the two cannot drift apart. */
export const DEFAULT_RUNNER_USER = "runner";
export const DEFAULT_TEMPLATE_DIR = "/opt/actions-runner";
/** Written as the setup script's last step, so it exists only if every step succeeded. */
export const READY_FILE = "/var/lib/vm-gh-runners/ready";
/**
 * Written by `build-image` as the last step of baking, and by nothing else. Its
 * presence tells the first-boot script that Docker, the runner user and the
 * runner's template directory are already in the image.
 */
export const BAKED_FILE = "/var/lib/vm-gh-runners/baked";

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

const validated = (options: UserDataOptions): Required<UserDataOptions> => {
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
  return opts;
};

const indent = (s: string, by = "  "): string =>
  s
    .split("\n")
    .map((line) => (line === "" ? "" : `${by}${line}`))
    .join("\n");

/**
 * Turns automatic upgrades off for the VM's life. It starts every script that
 * touches apt, the baked path included: the masked timers survive in a built
 * image, but the first-boot script must not depend on that.
 */
const NO_AUTO_UPGRADE = `# A CI VM never upgrades itself (DESIGN.md "No automatic upgrades"). The stock
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
APT="apt-get -o DPkg::Lock::Timeout=300 -y"`;

const installRunner = (version: string): string => `case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
${runnerVersionSnippet(version)}
rm -rf ${DEFAULT_TEMPLATE_DIR}
mkdir -p ${DEFAULT_TEMPLATE_DIR}
curl -fsSL --retry 5 "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-\${ARCH}-\${RUNNER_VERSION}.tar.gz" | tar -xz -C ${DEFAULT_TEMPLATE_DIR}
${DEFAULT_TEMPLATE_DIR}/bin/installdependencies.sh`;

/** Everything that does not depend on a run: packages, Docker, the runner user, the runner. */
const provision = (opts: Required<UserDataOptions>): string => `$APT update
$APT install ${[...BASE_PACKAGES, ...opts.extraPackages].join(" ")}
systemctl enable --now docker

id ${DEFAULT_RUNNER_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${DEFAULT_RUNNER_USER}
usermod -aG docker ${DEFAULT_RUNNER_USER}
echo '${DEFAULT_RUNNER_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${DEFAULT_RUNNER_USER}
chmod 0440 /etc/sudoers.d/${DEFAULT_RUNNER_USER}
visudo -cf /etc/sudoers.d/${DEFAULT_RUNNER_USER}

${installRunner(opts.runnerVersion)}`;

/**
 * The first-boot path on a built image: only what the image cannot know. It
 * installs nothing unless the caller asked for extra packages or pinned a runner
 * version other than the one baked in.
 */
const bakedBoot = (opts: Required<UserDataOptions>): string => {
  const lines = [
    "# Built by build-image: Docker, the runner user and the runner are in the image.",
    `BAKED_RUNNER="$(sed -n 's/^runner_version=//p' ${BAKED_FILE})"`,
    "systemctl enable --now docker",
  ];
  if (opts.extraPackages.length > 0) {
    lines.push("$APT update", `$APT install ${opts.extraPackages.join(" ")}`);
  }
  if (opts.runnerVersion !== "latest") {
    // "latest" means whatever was current at build time; only a pin can differ.
    lines.push(`if [ "$BAKED_RUNNER" != ${opts.runnerVersion} ]; then`, indent(installRunner(opts.runnerVersion)), "fi");
  }
  lines.push(
    "# A damaged image must fail here, not later in the registrar.",
    `test -x ${DEFAULT_TEMPLATE_DIR}/config.sh`,
    `id ${DEFAULT_RUNNER_USER} >/dev/null`,
  );
  return lines.join("\n");
};

const setupScript = (opts: Required<UserDataOptions>): string => `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

${NO_AUTO_UPGRADE}

# The marker is written only by a build-image build; without it this is a stock
# image and everything is installed here.
if [ ! -f ${BAKED_FILE} ]; then
${indent(provision(opts))}
else
${indent(bakedBoot(opts))}
fi

install -d /var/lib/vm-gh-runners
touch ${READY_FILE}
`;

/**
 * The script `build-image` runs over SSH on its temporary server: the first-boot
 * work done once, ahead of time, plus a full `dist-upgrade`, which a running CI
 * VM must never do. It leaves the BAKED_FILE marker and no READY_FILE. READY_FILE
 * is per VM and written by the first-boot script; a stale copy would make the
 * registrar trust a VM whose setup had failed.
 */
export const buildBakeScript = (options: UserDataOptions = {}): string => {
  const opts = validated(options);
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

${NO_AUTO_UPGRADE}

$APT update
$APT -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
${provision(opts)}
$APT autoremove

install -d /var/lib/vm-gh-runners
rm -f ${READY_FILE}
printf 'runner_version=%s\\nbuilt_at=%s\\n' "$RUNNER_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${BAKED_FILE}
`;
};

/**
 * The script `build-image` runs last. Clones of the image must boot as new
 * machines: a new instance for cloud-init (so user-data and the injected SSH key
 * apply again), a new machine-id and new SSH host keys. The builder's own SSH
 * key goes too, and no registry credential may be left behind.
 */
export const buildFinalizeScript = (): string => `#!/usr/bin/env bash
set -euo pipefail
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -f /root/.docker/config.json /home/*/.docker/config.json
rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys
rm -f /root/.bash_history /home/*/.bash_history
rm -f /etc/ssh/ssh_host_*
rm -f ${READY_FILE}
# cloud-init writes this again, from the new VM's own metadata, on first boot.
rm -f /etc/netplan/50-cloud-init.yaml
journalctl --rotate || true
journalctl --vacuum-time=1s || true
cloud-init clean --logs --seed
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
sync
`;

/** User-data for the builder's temporary server: only lets the SSH key log in as root. */
export const BUILDER_USER_DATA = `#cloud-config
ssh_pwauth: false
disable_root: false
`;

/** cloud-init user-data (`#cloud-config`) that prepares a fresh server to host runners. */
export const buildUserData = (options: UserDataOptions = {}): string => {
  const opts = validated(options);

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
