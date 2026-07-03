#!/usr/bin/env bash
set -euo pipefail

REPO="${ENVOQ_REPO:-envoq/client}"
INSTALL_DIR="${ENVOQ_INSTALL_DIR:-/usr/local/bin}"
BIN_NAME="${ENVOQ_BIN_NAME:-envoq}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "envoq installer requires $1" >&2
    exit 1
  fi
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "macos" ;;
    *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

supports_avx2() {
  if [ -r /proc/cpuinfo ]; then
    grep -qi 'avx2' /proc/cpuinfo
    return
  fi

  # macOS x64 release assets are built for modern Intel macOS hosts. Linux x64
  # gets a separate baseline asset because older VMs frequently lack AVX2.
  return 0
}

latest_tag() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

install_binary() {
  local src="$1"
  local dest="$2"

  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
  if [ -w "$INSTALL_DIR" ]; then
    install -m 0755 "$src" "$dest"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$INSTALL_DIR"
    sudo install -m 0755 "$src" "$dest"
    return
  fi

  echo "Cannot write to ${INSTALL_DIR} and sudo is unavailable." >&2
  echo "Set ENVOQ_INSTALL_DIR to a writable directory and run this installer again." >&2
  exit 1
}

need curl
need sed
need install

os="$(detect_os)"
arch="$(detect_arch)"
asset="envoq-${os}-${arch}"
if [ "$os" = "linux" ] && [ "$arch" = "x64" ] && ! supports_avx2; then
  asset="envoq-linux-x64-baseline"
fi
tag="$(latest_tag)"

if [ -z "$tag" ]; then
  echo "Unable to determine the latest Envoq release tag." >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
binary="${tmpdir}/${asset}"

echo "Downloading ${asset} from ${tag}..."
curl -fL "$url" -o "$binary"
chmod +x "$binary"

dest="${INSTALL_DIR%/}/${BIN_NAME}"
install_binary "$binary" "$dest"

echo "Installed Envoq to ${dest}"
"$dest" --version || true
