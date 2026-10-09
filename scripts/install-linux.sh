#!/usr/bin/env bash
# Installs a Shotmaster AppImage for the current user:
#   - the `shotmaster` command in ~/.local/bin (no args opens the app, flags run the CLI)
#   - a launcher in the app menu / search
# Usage: scripts/install-linux.sh [path/to/Shotmaster.AppImage]
#        scripts/install-linux.sh --uninstall
set -euo pipefail

APP_DIR="$HOME/.local/share/shotmaster"
BIN="$HOME/.local/bin/shotmaster"
DESKTOP="$HOME/.local/share/applications/shotmaster.desktop"
ICON="$APP_DIR/shotmaster.png"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$APP_DIR" "$BIN" "$DESKTOP"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "Shotmaster uninstalled."
  exit 0
fi

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  SRC=$(ls -t "$(dirname "$0")"/../release/Shotmaster-*.AppImage 2>/dev/null | head -1 || true)
fi
[[ -f "$SRC" ]] || { echo "AppImage not found. Pass its path: $0 path/to/Shotmaster.AppImage" >&2; exit 1; }

mkdir -p "$APP_DIR" "$(dirname "$BIN")" "$(dirname "$DESKTOP")"
install -m 755 "$SRC" "$APP_DIR/Shotmaster.AppImage"

# Pull the icon out of the AppImage.
tmp=$(mktemp -d)
(cd "$tmp" && "$APP_DIR/Shotmaster.AppImage" --appimage-extract 'usr/share/icons/*' >/dev/null)
install -m 644 "$(find "$tmp/squashfs-root" -name shotmaster.png | sort -V | tail -1)" "$ICON"
rm -rf "$tmp"

# Wrapper: ELECTRON_RUN_AS_NODE (set in VS Code terminals) would make Electron act as plain Node.
cat > "$BIN" <<EOF
#!/bin/sh
unset ELECTRON_RUN_AS_NODE
exec "$APP_DIR/Shotmaster.AppImage" "\$@"
EOF
chmod 755 "$BIN"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Shotmaster
Comment=Minimal video cutter, zoomer and compressor
Exec=$BIN
Icon=$ICON
Terminal=false
Categories=AudioVideo;Video;
StartupWMClass=Shotmaster
EOF
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

echo "Installed Shotmaster."
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Note: add ~/.local/bin to your PATH to use the 'shotmaster' command." ;;
esac
