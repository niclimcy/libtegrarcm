#!/usr/bin/env bash
# Regenerates tests/golden/{rcm_0,rcm_1}.rcm and t210_p3448.bct from a real
# NVIDIA T210 (Jetson Nano P3448) flash package, by running the package's own
# statically-linked i386 tegraflash tools under a linux/386 docker container.
#
# Usage: tools/regenerate-t210.sh <path-to-p3450_flash_package.tar.xz>
#
# Get the flash package from https://download.lineageos.org/devices/porg
# (its "Download flash package" link — see the LineageOS wiki install page for
# the Jetson Nano). See PROTOCOL.md for what each golden fixture asserts.
set -euo pipefail

PACKAGE=${1:?"usage: $0 <path-to-p3450_flash_package.tar.xz>"}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GOLDEN_DIR=$(cd "$SCRIPT_DIR/../tests/golden" && pwd)
IMG=debian:trixie-slim

# A subdirectory of the project (rather than the system tmpdir) so it's
# reliably visible to Docker Desktop's file-sharing allowlist.
WORK=$(mktemp -d "$SCRIPT_DIR/.regen-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "Extracting $PACKAGE..."
tar -xJf "$PACKAGE" -C "$WORK"
cd "$WORK"

run() { docker run --rm --platform linux/386 -v "$WORK":/w -w /w "$IMG" "$@"; }

echo "Generating rcm_1.rcm (unsigned download-and-execute message, 256-byte 0xAA payload)..."
python3 -c "open('payload_aa.bin','wb').write(b'\xAA'*256)"
run ./tegraflash/tegrarcm --chip 0x21 --listrcm rcm_list.xml --download rcm payload_aa.bin 0 0
cp "$WORK/rcm_1.rcm" "$GOLDEN_DIR/rcm_1.rcm"
if [ -f "$WORK/rcm_0.rcm" ]; then cp "$WORK/rcm_0.rcm" "$GOLDEN_DIR/rcm_0.rcm"; fi

echo "Generating t210_p3448.bct (finalized BCT for the Jetson Nano P3448 board)..."
BCT=P3448_A00_lpddr4_204Mhz_P987
run ./tegraflash/tegrabct --bct $BCT.cfg --chip 0x21                # base gen -> $BCT.bct
run ./tegraflash/tegraparser --pt flash_android_t210_emmc_p3448.xml # -> .bin
run ./tegraflash/tegrabct --bct $BCT.bct --chip 0x21 --updatedevparam flash_android_t210_emmc_p3448.bin
run ./tegraflash/tegrabct --bct $BCT.bct --chip 0x21 --updateblinfo flash_android_t210_emmc_p3448.bin
cp "$WORK/$BCT.bct" "$GOLDEN_DIR/t210_p3448.bct"
cp "$WORK/$BCT.cfg" "$GOLDEN_DIR/sdramcfg/t210_p3448.cfg" # source cfg for the sdram-parser test

echo "Extracting sdram field tables from the tegrabct binary..."
node "$SCRIPT_DIR/extract-chip-tables.ts" --fields-only \
	"$WORK/tegraflash/tegrabct" > "$GOLDEN_DIR/chiptables/t210_sdram.json"

echo "Done. Updated:"
echo "  $GOLDEN_DIR/rcm_1.rcm"
echo "  $GOLDEN_DIR/t210_p3448.bct"
echo "  $GOLDEN_DIR/sdramcfg/t210_p3448.cfg"
echo "Run 'pnpm test' from the package root to validate."
