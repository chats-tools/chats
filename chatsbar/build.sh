#!/bin/zsh
# Builds ChatsBar.app from this folder and puts it in ~/Applications. Needs Apple's
# Command Line Tools (swiftc, codesign); no Xcode, and nothing is downloaded. Run: zsh build.sh
# The demo data (../chats-panel/demo/demo.json) is copied into the app, next to chats.py.
set -euo pipefail
SRC="${0:A:h}"
WORK="$(mktemp -d)"
APP="$WORK/ChatsBar.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/ChatsBar" "$SRC/ChatsBar.swift"
cp "$SRC/chats.py" "$APP/Contents/Resources/chats.py"
DEMO="$SRC/../chats-panel/demo/demo.json"
[[ -f "$DEMO" ]] || { echo "Missing $DEMO (build from the full repo folder)" >&2; exit 1; }
cp "$DEMO" "$APP/Contents/Resources/demo.json"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ChatsBar</string>
  <key>CFBundleIdentifier</key><string>io.github.chatsbar</string>
  <key>CFBundleExecutable</key><string>ChatsBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>io.github.chatsbar</string>
    <key>CFBundleURLSchemes</key><array><string>chatsbar</string></array>
  </dict></array>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/ChatsBar.app"
mv "$APP" "$HOME/Applications/ChatsBar.app"
rm -rf "$WORK"
echo "Built $HOME/Applications/ChatsBar.app"
