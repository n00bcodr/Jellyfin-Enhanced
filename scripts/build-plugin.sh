#!/usr/bin/env bash
set -euo pipefail

# Builds a Jellyfin Enhanced release artifact for one Jellyfin line and emits the
# plugin meta.json, a zip ready to attach to a GitHub release, and the MD5 checksum
# that manifest.json needs.
#
# The SAME source builds for both runtimes (the File-Transformation-free injection
# uses only standard ASP.NET). Build one artifact per line — never one DLL for both:
#
#   scripts/build-plugin.sh jf12   # Jellyfin 12,    .NET 10, targetAbi 12.0.0.0   (default)
#   scripts/build-plugin.sh jf10   # Jellyfin 10.11, .NET 9,  targetAbi 10.11.0.0
#
# Requires: .NET SDK 10 (it can target net9.0 too). zip is optional (python3 fallback).

TARGET="${1:-jf12}"
case "$TARGET" in
  jf12) TFM="net10.0"; ABI="12.0.0.0";  JF_LABEL="12.0.0-rc1" ;;
  jf10) TFM="net9.0";  ABI="10.11.0.0"; JF_LABEL="10.11.0" ;;
  *) echo "Usage: $0 [jf12|jf10]" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROJ_DIR="$ROOT/Jellyfin.Plugin.JellyfinEnhanced"
PROJ="$PROJ_DIR/JellyfinEnhanced.csproj"

VERSION="$(grep -oE '<AssemblyVersion>[^<]+' "$PROJ" | head -1 | sed 's/<AssemblyVersion>//')"
GUID="f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b"

OUT_DIR="$ROOT/dist"
STAGE="$OUT_DIR/Jellyfin.Plugin.JellyfinEnhanced_${JF_LABEL}"
ZIP="$OUT_DIR/Jellyfin.Plugin.JellyfinEnhanced_${JF_LABEL}.zip"

echo "Building Jellyfin Enhanced ${VERSION} for ${TARGET} (${TFM}, Jellyfin ${JF_LABEL}, targetAbi ${ABI})..."
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

dotnet build "$PROJ" -c Release -p:JellyfinTarget="$TARGET" --nologo

BIN="$PROJ_DIR/bin/Release/${TFM}"
cp "$BIN/Jellyfin.Plugin.JellyfinEnhanced.dll" "$STAGE/"
[ -f "$BIN/Jellyfin.Plugin.JellyfinEnhanced.deps.json" ] && cp "$BIN/Jellyfin.Plugin.JellyfinEnhanced.deps.json" "$STAGE/"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.0000000Z 2>/dev/null || echo '1970-01-01T00:00:00.0000000Z')"
cat > "$STAGE/meta.json" <<EOF
{
  "category": "General",
  "changelog": "Jellyfin ${JF_LABEL} build. Client script + custom branding injected by the plugin itself (File Transformation no longer required).",
  "description": "A combination of the Jellyfin Enhanced and Jellyfin Elsewhere userscripts.",
  "guid": "${GUID}",
  "name": "Jellyfin Enhanced",
  "overview": "Jellyfin Enhanced and Jellyfin Elsewhere for a better Jellyfin experience.",
  "owner": "n00bcodr",
  "targetAbi": "${ABI}",
  "timestamp": "${TIMESTAMP}",
  "version": "${VERSION}",
  "status": "Active",
  "autoUpdate": false,
  "assemblies": [
    "Jellyfin.Plugin.JellyfinEnhanced.dll"
  ]
}
EOF

if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGE" && zip -q -r "$ZIP" . )
else
  # Fallback when the zip CLI isn't installed (e.g. minimal CI images).
  python3 - "$STAGE" "$ZIP" <<'PY'
import os, sys, zipfile
stage, zippath = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zippath, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(stage):
        for f in sorted(files):
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, stage))
PY
fi

MD5="$(md5sum "$ZIP" | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')"

echo
echo "Built: $ZIP"
echo "Version:   $VERSION"
echo "targetAbi: $ABI"
echo "checksum (MD5, for manifest.json): $MD5"
