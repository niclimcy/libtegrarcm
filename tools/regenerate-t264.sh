#!/usr/bin/env bash
# Regenerates tests/golden/chiptables/t264_sdram.json from an NVIDIA Jetson
# Linux R38+/JetPack 7 "Thor" BSP (Jetson_Linux_R3x.y.z_aarch64.tbz2), whose
# single tegrabct_v2 still ships as an unstripped i386 ELF and carries the
# sdram parse tables for every v2-family chip at once (T18x, T19x, T23x,
# T264). Pure symtab extraction — unlike the other regenerate scripts, no
# docker/i386 execution is needed.
#
# Usage: tools/regenerate-t264.sh <path-to-Jetson_Linux_R39.x_aarch64.tbz2>
#
# Get the "Jetson Linux Driver Package (BSP)" from
# https://developer.nvidia.com/embedded/jetson-linux-archive
#
# Note: R38+ tegrarcm_v2 dropped --listrcm (it only talks to live devices),
# so T234/T264 RCM goldens cannot be generated offline the way
# regenerate-t{186,194}.sh do.
set -euo pipefail

PACKAGE=${1:?"usage: $0 <path-to-Jetson_Linux_R39.x_aarch64.tbz2>"}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GOLDEN_DIR=$(cd "$SCRIPT_DIR/../tests/golden" && pwd)

WORK=$(mktemp -d "$SCRIPT_DIR/.regen-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "Extracting tegrabct_v2 from $PACKAGE (single-member pass over the full tarball; takes a few minutes)..."
tar -xjf "$PACKAGE" -C "$WORK" --strip-components=2 \
	Linux_for_Tegra/bootloader/tegrabct_v2

echo "Extracting sdram field tables from the tegrabct_v2 binary..."
node "$SCRIPT_DIR/extract-chip-tables.ts" --fields-only \
	"$WORK/tegrabct_v2" > "$GOLDEN_DIR/chiptables/t264_sdram.json"

echo "Done. Updated $GOLDEN_DIR/chiptables/t264_sdram.json. Run 'pnpm test' to validate."
