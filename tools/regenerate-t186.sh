#!/usr/bin/env bash
# Regenerates tests/golden/t186_<board>_{br,mb1}.bct from a real NVIDIA T186
# (Jetson TX2 "quill") flash package, by running the package's own
# statically-linked i386 tegraflash_v2 tools under a linux/386 docker
# container. Board (P2771 devkit carrier vs P3636-P3509) is auto-detected
# from the cfg filenames the package ships.
#
# Usage: tools/regenerate-t186.sh <path-to-flash_package.tar.xz>
#
# Get the flash package from https://download.lineageos.org/devices/quill
# (its "Download flash package" link — which board a given build targets
# depends on carrier revision, hence the auto-detection below).
# See PROTOCOL.md for what each golden fixture asserts, and why only the
# header + SDRAM section (not the full BR-BCT/MB1-BCT) is golden-checked.
set -euo pipefail

PACKAGE=${1:?"usage: $0 <path-to-flash_package.tar.xz>"}
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

if [ -f "P3310_A00_8GB_lpddr4_A02_l4t.cfg" ]; then
	BOARD=p2771
	SDRAM_CFG=P3310_A00_8GB_lpddr4_A02_l4t.cfg
	PINMUX_CFG=tegra186-mb1-bct-pinmux-quill-p3310-1000-c03.cfg
	PAD_CFG=tegra186-mb1-bct-pad-quill-p3310-1000-c03.cfg
	PMIC_CFG=tegra186-mb1-bct-pmic-quill-p3310-1000-c03.cfg
	BOOTROM_CFG=tegra186-mb1-bct-bootrom-quill-p3310-1000-c03.cfg
	PROD_CFG=tegra186-mb1-bct-prod-quill-p3310-1000-c03.cfg
elif [ -f "tegra186-mb1-bct-memcfg-p3636-0001-a01.cfg" ]; then
	BOARD=p3636-p3509
	SDRAM_CFG=tegra186-mb1-bct-memcfg-p3636-0001-a01.cfg
	PINMUX_CFG=tegra186-mb1-bct-pinmux-p3636-0001-a00.cfg
	PAD_CFG=tegra186-mb1-bct-pad-p3636-0001-a00.cfg
	PMIC_CFG=tegra186-mb1-bct-pmic-p3636-0001-a00.cfg
	BOOTROM_CFG=tegra186-mb1-bct-bootrom-p3636-0001-a00.cfg
	PROD_CFG=tegra186-mb1-bct-prod-p3636-0001-a00.cfg
else
	echo "Unrecognized T186 flash package: no known sdram/mb1-bct cfg found." >&2
	exit 1
fi
echo "Detected board: $BOARD"

echo "Generating br_bct_BR.bct (Bootrom BCT)..."
run ./tegraflash/tegrabct_v2 --chip 0x18 \
	--dev_param emmc.cfg \
	--sdram "$SDRAM_CFG" \
	--brbct br_bct.cfg
cp "$WORK/br_bct_BR.bct" "$GOLDEN_DIR/t186_${BOARD}_br.bct"

echo "Generating mb1_cold_boot_bct_MB1.bct (MB1-BCT, cold-boot variant)..."
run ./tegraflash/tegrabct_v2 --chip 0x18 \
	--mb1bct mb1_cold_boot_bct.cfg \
	--sdram "$SDRAM_CFG" \
	--misc tegra186-mb1-bct-misc-si-l4t.cfg \
	--scr mobile_scr.cfg \
	--pinmux "$PINMUX_CFG" \
	--pmc "$PAD_CFG" \
	--pmic "$PMIC_CFG" \
	--brcommand "$BOOTROM_CFG" \
	--prod "$PROD_CFG"
cp "$WORK/mb1_cold_boot_bct_MB1.bct" "$GOLDEN_DIR/t186_${BOARD}_mb1.bct"
cp "$WORK/$SDRAM_CFG" "$GOLDEN_DIR/sdramcfg/t186_${BOARD}.cfg" # source cfg for the sdram-parser test

echo "Extracting sdram field tables from the tegrabct_v2 binary..."
node "$SCRIPT_DIR/extract-chip-tables.ts" --fields-only \
	"$WORK/tegraflash/tegrabct_v2" > "$GOLDEN_DIR/chiptables/t186_sdram.json"

# RCM messages are chip-level, not board-specific (same bytes for either board),
# so these are unsuffixed. rcm_0 = version query (wire opcode 7), rcm_1 = the
# unsigned download-and-execute message for a 256-byte 0xAA payload.
echo "Generating t186_rcm_{0,1}.rcm (unsigned RCM messages, chip 0x18)..."
python3 -c "open('payload_aa.bin','wb').write(b'\xAA'*256)"
run ./tegraflash/tegrarcm_v2 --chip 0x18 --listrcm rcm_list.xml --download rcm payload_aa.bin 0 0
cp "$WORK/rcm_0.rcm" "$GOLDEN_DIR/t186_rcm_0.rcm"
cp "$WORK/rcm_1.rcm" "$GOLDEN_DIR/t186_rcm_1.rcm"

echo "Done. Updated:"
echo "  $GOLDEN_DIR/t186_${BOARD}_br.bct"
echo "  $GOLDEN_DIR/t186_${BOARD}_mb1.bct"
echo "  $GOLDEN_DIR/sdramcfg/t186_${BOARD}.cfg"
echo "  $GOLDEN_DIR/t186_rcm_0.rcm, t186_rcm_1.rcm"
echo "Run 'pnpm test' from the package root to validate (update tests/bct/T186.test.ts"
echo "if you regenerated a board other than p2771 — it currently asserts against that one)."
