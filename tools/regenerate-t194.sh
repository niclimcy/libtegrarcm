#!/usr/bin/env bash
# Regenerates tests/golden/t194_rcm_{0,1}.rcm from a real NVIDIA T18x/T19x L4T
# Driver Package (BSP), by running the package's own statically-linked i386
# tegrarcm_v2 under a linux/386 docker container. These RCM messages are
# chip-level (not board-specific), so any T194-capable BSP works.
#
# Usage: tools/regenerate-t194.sh <path-to-Jetson_Linux_R32.x_aarch64.tbz2>
#
# The R32.1.0 "JAX-TX2" BSP is a combined T186+T194 package (bootloader/t186ref
# holds both tegra186-* and tegra194-* fragments) — see PROTOC

PACKAGE=${1:?"usage: $0 <path-to-Jetson_Linux_R32.x_aarch64.tbz2>"}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GOLDEN_DIR=$(cd "$SCRIPT_DIR/../tests/golden" && pwd)
IMG=debian:trixie-slim

WORK=$(mktemp -d "$SCRIPT_DIR/.regen-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "Extracting tegrarcm_v2 from $PACKAGE..."
tar -xjf "$PACKAGE" -C "$WORK" --strip-components=2 \
	Linux_for_Tegra/bootloader/tegrarcm_v2
cd "$WORK"

rcm() { docker run --rm --platform linux/386 -v "$WORK":/w -w /w "$IMG" \
	./tegrarcm_v2 --chip 0x19 --listrcm rcm_list.xml --download rcm "$1" 0 0 >/dev/null; }

echo "Generating t194_rcm_{0,1}.rcm (256-byte 0xAA payload)..."
python3 -c "open('payload_aa.bin','wb').write(b'\xAA'*256)"
rcm payload_aa.bin
cp "$WORK/rcm_0.rcm" "$GOLDEN_DIR/t194_rcm_0.rcm" # version-query message (opcode 7, empty payload)
cp "$WORK/rcm_1.rcm" "$GOLDEN_DIR/t194_rcm_1.rcm" # download message (opcode 5)

echo "Generating t194_rcm_p1.rcm (1-byte payload — odd, unpadded total)..."
python3 -c "open('payload_1.bin','wb').write(b'\xCC')"
rcm payload_1.bin
cp "$WORK/rcm_1.rcm" "$GOLDEN_DIR/t194_rcm_p1.rcm"

echo "Done. Updated t194_rcm_{0,1,p1}.rcm. Run 'pnpm test' to validate."
