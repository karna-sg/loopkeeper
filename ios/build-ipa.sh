#!/usr/bin/env bash
# Build an UNSIGNED device .ipa for sideloading with a FREE Apple ID (Sideloadly / AltStore).
# Sideloadly re-signs it with your Apple ID and installs it on the iPhone (7-day validity).
# Usage:  bash ios/build-ipa.sh   ->   produces ios/Loopkeeper.ipa
set -euo pipefail
cd "$(dirname "$0")"

xcodegen generate >/dev/null

echo "▸ Building unsigned device app (Release)…"
xcodebuild -project Loopkeeper.xcodeproj -scheme Loopkeeper \
  -sdk iphoneos -configuration Release -derivedDataPath /tmp/lk-ios \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build | tail -3

APP=/tmp/lk-ios/Build/Products/Release-iphoneos/Loopkeeper.app
[ -d "$APP" ] || { echo "✗ no app produced at $APP"; exit 1; }

WORK=$(mktemp -d)
mkdir -p "$WORK/Payload"
cp -R "$APP" "$WORK/Payload/"
OUT="$PWD/Loopkeeper.ipa"
rm -f "$OUT"
(cd "$WORK" && zip -qry "$OUT" Payload)

echo "✅ Wrote $OUT"
echo "   Install with Sideloadly (https://sideloadly.io): connect iPhone, drop this .ipa,"
echo "   sign in with your free Apple ID. Re-run weekly to refresh the 7-day signature."
