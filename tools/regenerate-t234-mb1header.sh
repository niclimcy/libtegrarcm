#!/usr/bin/env bash
# Regenerates tests/golden/{t234,t264}_mb1_nvheader.bin — real `tegrahost_v2
# --addmb1nvheader` output wrapping a synthetic payload, by running the
# package's own statically-linked i386 tegrahost_v2 under a linux/386 docker
# container (chip 0x23 for T234, 0x26 for T264; verified byte-identical
# layout between the two).
#
# A synthetic payload (not a real MB1 image) is deliberately used: the goal is
# only to pin the wrapper's fixed-size header layout (see mb1NvHeader.ts),
# which this repo has confirmed is independent of payload content/size. A real
# MB1 image would additionally require the board's OEM signing key.
#
# Usage: tools/regenerate-t234-mb1header.sh <path-to-Jetson_Linux_R39.x_aarch64.tbz2>
#
# Get the "Jetson Linux Driver Package (BSP)" from
# https://developer.nvidia.com/embedded/jetson-linux-archive
set -euo pipefail

PACKAGE=${1:?"usage: $0 <path-to-Jetson_Linux_R39.x_aarch64.tbz2>"}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GOLDEN_DIR=$(cd "$SCRIPT_DIR/../tests/golden" && pwd)
IMG=debian:trixie-slim

WORK=$(mktemp -d "$SCRIPT_DIR/.regen-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "Extracting tegrahost_v2 from $PACKAGE..."
tar -xjf "$PACKAGE" -C "$WORK" --strip-components=2 \
	Linux_for_Tegra/bootloader/tegrahost_v2
cd "$WORK"

run() { docker run --rm --platform linux/386 -v "$WORK":/w -w /w "$IMG" "$@"; }

gen() {
	local chip=$1 name=$2 size=$3 fill=$4 magic=$5 outname=$6
	python3 -c "open('${name}.bin','wb').write(bytes([${fill}])*${size})"
	cp "${name}.bin" "${name}_aligned.bin"
	run ./tegrahost_v2 --chip "$chip" 0 --align "${name}_aligned.bin"
	# tegrahost_v2 logs "Header already present for <output>.bin" here even on
	# a fresh build (checked against the not-yet-written output path) — benign
	# tool chatter, not a skip: the header is freshly populated every time
	# (verified by SHA-512-of-payload and payload-size fields tracking the
	# input across multiple distinct runs).
	run ./tegrahost_v2 --chip "$chip" 0 --ratchet 0 0 --magicid "$magic" \
		--addmb1nvheader "${name}_aligned.bin" nvidia-rsa
	cp "${name}_aligned_sigheader.bin" "$GOLDEN_DIR/${outname}.bin"
}

echo "Generating t234_mb1_nvheader.bin (chip 0x23, 256-byte 0xAA payload, magicid MB1B)..."
gen 0x23 t234 256 0xAA MB1B t234_mb1_nvheader

echo "Generating t264_mb1_nvheader.bin (chip 0x26, 512-byte 0x33 payload, magicid MB1B)..."
gen 0x26 t264 512 0x33 MB1B t264_mb1_nvheader

# PSCB gets a different hardcoded load/second address than MB1B (0x120000 /
# 0x120400 vs 0x50000000 / 0x50000000) — this and the unrecognized-magic case
# below pin the `secondAddress`/flag-bytes fields against the real tool's
# dispatch, not just disassembly.
echo "Generating t234_mb1_nvheader_pscb.bin (chip 0x23, 64-byte payload, magicid PSCB)..."
gen 0x23 t234pscb 64 0x22 PSCB t234_mb1_nvheader_pscb

# T264's Fill chain hardcodes PSCB's loadAddress as 0x110000, not the T234
# value 0x120000 (secondAddress 0x120400 is shared) — the one place the two
# chips' address tables diverge. This golden locks that difference.
echo "Generating t264_mb1_nvheader_pscb.bin (chip 0x26, 64-byte payload, magicid PSCB)..."
gen 0x26 t264pscb 64 0x44 PSCB t264_mb1_nvheader_pscb

echo "Generating t234_mb1_nvheader_unrecognized.bin (chip 0x23, 64-byte payload, magicid XXXX)..."
gen 0x23 t234unrec 64 0x22 XXXX t234_mb1_nvheader_unrecognized

# TSEC is recognized by the stage0 copy-vs-generic gate (~12 names) but NOT by
# the separate loadAddress table (~6 names) — this is what proves the two
# gates are independent: TSEC's stage1 addresses stay zero (like an
# unrecognized name) while stage0 still faithfully mirrors stage1 (like a
# recognized name), rather than falling back to the generic stage0 path.
echo "Generating t234_mb1_nvheader_tsec.bin (chip 0x23, 48-byte payload, magicid TSEC)..."
gen 0x23 t234tsec 48 0x11 TSEC t234_mb1_nvheader_tsec

echo "Done. Updated:"
echo "  $GOLDEN_DIR/t234_mb1_nvheader.bin"
echo "  $GOLDEN_DIR/t264_mb1_nvheader.bin"
echo "  $GOLDEN_DIR/t234_mb1_nvheader_pscb.bin"
echo "  $GOLDEN_DIR/t264_mb1_nvheader_pscb.bin"
echo "  $GOLDEN_DIR/t234_mb1_nvheader_unrecognized.bin"
echo "  $GOLDEN_DIR/t234_mb1_nvheader_tsec.bin"
echo "Run 'pnpm test' from the package root to validate."
