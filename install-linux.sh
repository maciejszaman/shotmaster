#!/bin/sh
# Installs Shotmaster for the current user: an app menu entry and the `shotmaster` command.
#
#   sh install-linux.sh [Shotmaster-x.y.z-linux-x86_64.AppImage]
#   sh install-linux.sh --uninstall
#
# Without a path it picks the newest Shotmaster AppImage next to this script, in the
# current directory, or in ~/Downloads. Run it again with a newer AppImage to update.
set -e

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APPIMAGE="$HOME/Applications/Shotmaster.AppImage"
BIN="$HOME/.local/bin/shotmaster"
ICON="$DATA/icons/shotmaster.png"
DESKTOP="$DATA/applications/shotmaster.desktop"

if [ "$1" = --uninstall ]; then
  rm -f "$APPIMAGE" "$BIN" "$ICON" "$DESKTOP"
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  echo "Shotmaster uninstalled."
  exit 0
fi

src=$1
if [ -z "$src" ]; then
  src=$(ls -t "$(dirname "$0")"/Shotmaster-*.AppImage ./Shotmaster-*.AppImage \
    "$HOME"/Downloads/Shotmaster-*.AppImage 2>/dev/null | head -n 1)
fi
if [ ! -f "$src" ]; then
  echo "Shotmaster AppImage not found. Usage: sh $0 path/to/Shotmaster.AppImage" >&2
  exit 1
fi

mkdir -p "$(dirname "$APPIMAGE")" "$(dirname "$BIN")" "$(dirname "$ICON")" "$(dirname "$DESKTOP")"
install -m 755 "$src" "$APPIMAGE"

# Icon from inside the AppImage (extracting doesn't need FUSE).
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && "$APPIMAGE" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1) || true
png=$(find "$tmp" -name '*.png' 2>/dev/null | head -n 1)
[ -n "$png" ] && cp "$png" "$ICON"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Name=Shotmaster
Comment=Clip cutter and video compressor (FFMPEG UI)
Exec="$APPIMAGE" --no-sandbox %U
TryExec=$APPIMAGE
Icon=$ICON
Terminal=false
Type=Application
StartupWMClass=Shotmaster
Categories=AudioVideo;Video;
EOF
update-desktop-database "$DATA/applications" 2>/dev/null || true

cat > "$BIN" <<EOF
#!/bin/sh
# Shotmaster CLI. Unset ELECTRON_RUN_AS_NODE (leaks from VS Code) or Electron runs as plain node.
unset ELECTRON_RUN_AS_NODE
exec "$APPIMAGE" "\$@"
EOF
chmod 755 "$BIN"

echo "Shotmaster installed. Open it from your app menu, or run 'shotmaster -h' in a terminal."

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Note: $HOME/.local/bin isn't on your PATH yet. Log out and back in, or add it in ~/.profile." ;;
esac

if ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'; then
  echo "Note: AppImages need FUSE 2, which looks missing. Install it with:"
  echo "  Ubuntu/Debian: sudo apt install libfuse2t64   (libfuse2 on Ubuntu 22.04 and older)"
  echo "  Fedora:        sudo dnf install fuse-libs"
  echo "  Arch:          sudo pacman -S fuse2"
fi
