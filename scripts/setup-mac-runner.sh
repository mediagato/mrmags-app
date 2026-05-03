#!/usr/bin/env bash
# One-paste self-hosted GHA runner installer — works on Apple Silicon AND Intel Macs.
#
# Usage:
#   TOKEN=ACABxxxxxxx bash <(curl -fsSL https://raw.githubusercontent.com/mediagato/mrmags-app/main/scripts/setup-mac-runner.sh)
#
# Token comes from https://github.com/mediagato/mrmags-app/settings/actions/runners/new
# (single-use, ~1hr expiry — get it just before running this).
#
# What this does:
#   1. Auto-detects arm64 (Apple Silicon) vs x86_64 (Intel)
#   2. Downloads + unpacks the matching GHA runner to ~/actions-runner
#   3. Configures it for mediagato/mrmags-app, name elizabeth-mac
#   4. Installs as a user-mode launchd service (no sudo) and starts it
#   5. Prints status so you can confirm it's online
#
# Safe to re-run: bails early if ~/actions-runner already exists.

set -euo pipefail

# --- config -----------------------------------------------------------------

REPO_OWNER="mediagato"
REPO_NAME="mrmags-app"
RUNNER_NAME="elizabeth-mac"
RUNNER_VERSION="2.334.0"

INSTALL_DIR="$HOME/actions-runner"

# --- arch detect ------------------------------------------------------------

ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  RUNNER_ARCH="arm64"
  ARCH_LABEL="ARM64"
elif [[ "$ARCH" == "x86_64" ]]; then
  RUNNER_ARCH="x64"
  ARCH_LABEL="x64"
else
  echo "error: unsupported architecture: $ARCH"
  exit 1
fi

RUNNER_LABELS="self-hosted,macOS,${ARCH_LABEL},real-mac"

# --- preflight --------------------------------------------------------------

if [[ -z "${TOKEN:-}" ]]; then
  echo "error: TOKEN env var not set."
  echo "Get one at: https://github.com/${REPO_OWNER}/${REPO_NAME}/settings/actions/runners/new"
  echo "Then re-run: TOKEN=ACABxxxxx bash <(curl -fsSL https://raw.githubusercontent.com/mediagato/mrmags-app/main/scripts/setup-mac-runner.sh)"
  exit 1
fi

if [[ -d "$INSTALL_DIR" ]]; then
  echo "error: $INSTALL_DIR already exists. If you want to reinstall, run:"
  echo "  cd $INSTALL_DIR && ./svc.sh stop && ./svc.sh uninstall && cd .. && rm -rf $INSTALL_DIR"
  exit 1
fi

echo "Setting up self-hosted GHA runner for ${REPO_OWNER}/${REPO_NAME} (arch: ${ARCH} -> ${RUNNER_ARCH})..."

# --- 1. download + unpack ---------------------------------------------------

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

TARBALL="actions-runner-osx-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

echo "Downloading runner v${RUNNER_VERSION}..."
curl -fsSL -o "$TARBALL" "$URL"

echo "Unpacking..."
tar xzf "$TARBALL"
rm "$TARBALL"

# --- 2. configure -----------------------------------------------------------

echo "Registering with GitHub..."
./config.sh \
  --url "https://github.com/${REPO_OWNER}/${REPO_NAME}" \
  --token "$TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --unattended \
  --replace

# --- 3. install as service --------------------------------------------------

echo "Installing as user-mode launchd service..."
./svc.sh install

echo "Starting service..."
./svc.sh start

# Brief pause for launchd to actually flip state
sleep 2

echo
echo "--- service status ---"
./svc.sh status || true

echo
echo "Done. Verify the runner shows up green at:"
echo "  https://github.com/${REPO_OWNER}/${REPO_NAME}/settings/actions/runners"
echo
echo "Next: System Settings -> Battery -> Power Adapter ->"
echo "  enable 'Prevent automatic sleeping when display is off'."
