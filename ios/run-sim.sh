#!/usr/bin/env bash
# Build + run Loopkeeper on the iPhone 17 Pro (iOS 26.5) simulator — no Xcode GUI needed.
# Usage:  bash ios/run-sim.sh
# (Backend must be running: cd backend && pnpm run seed && pnpm run dev)
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ Resolving iPhone 17 Pro (iOS 26.5)…"
UDID=$(xcrun simctl list devices available -j | python3 -c '
import sys, json
devices = json.load(sys.stdin)["devices"]
for runtime, devs in devices.items():
    if "iOS-26-5" in runtime:
        for dev in devs:
            if dev["name"] == "iPhone 17 Pro":
                print(dev["udid"]); sys.exit(0)
sys.exit("No iPhone 17 Pro on iOS 26.5. Run once: xcodebuild -downloadPlatform iOS")
')
echo "  device: $UDID"

echo "▸ Generating project…"
xcodegen generate >/dev/null

echo "▸ Building (this can take a minute)…"
xcodebuild -project Loopkeeper.xcodeproj -scheme Loopkeeper \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath /tmp/lk-dd build | tail -4

echo "▸ Booting simulator…"
open -a Simulator
xcrun simctl boot "$UDID" 2>/dev/null || true

APP=/tmp/lk-dd/Build/Products/Debug-iphonesimulator/Loopkeeper.app
echo "▸ Installing & launching…"
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.curiescious.loopkeeper

echo "✅ Loopkeeper is running in the Simulator."
echo "   (If the list is empty: cd ../backend && pnpm run seed && pnpm run dev)"
