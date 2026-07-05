# libtegrarcm

WebUSB library for flashing NVIDIA Jetson devices in **RCM** (Recovery Mode / APX) from the browser — a TypeScript reimplementation of NVIDIA's Linux-only `tegraflash`/`tegrarcm` pipeline (VID `0955`).

Targets Jetson TX1/Nano (**T210**, `0x21`), TX2 (**T186**, `0x18`), and AGX Xavier / Xavier NX (**T194**, `0x19`): drives the boot stack over RCM, the browser equivalent of the `flash.sh` → `tegrarcm`/`tegrabct`/`tegrasign` flow.

## Features

- RCM transport over WebUSB: connect, read the 16-byte chip UID (ECID), bulk message/status exchange
- RCM message framing for T210, T186, and T194 (`buildT210RcmMessage` / `buildT186RcmMessage` / `buildT194RcmMessage`), identical to `tegrarcm`/`tegrarcm_v2`
- BCT assembly: T210 `serializeBct` + bootloader-table patching; **full T186 BR-BCT + MB1-BCT assembly** (`assembleBrBct` / `assembleMb1Bct`) — header, packed SDRAM boot-scratch, fragment directory, scr 2-bit tail, and all six platform-config fragments (pinmux/scr/pad/pmic/brcommand/prod) — byte-identical to `tegrabct_v2`
- SDRAM parameter compilation (`parseSdramCfg`): packs a board's SDRAM `.cfg` into the BCT's NvBootSdramParams sets for T210 and T186, identical to `tegrabct`/`tegrabct_v2`
- Chip profile registry (`chipProfile`): everything chip-specific — RCM framing, BCT layouts, SDRAM cfg layout, applet address — as one descriptor per chip
- Signing (`tegrasign` parity): zero-key (SBK) AES-CMAC and RSA-PSS — `sbkHash`, `aesCmac`, `signRsaPss`
- Flash-package pipeline: an untarred `*_flash_package.txz` → BCT(s) + boot images + applet with no NVIDIA tool — `buildV1BootPackage` (v1 family, T124/T132/T210) and `buildV2BootPackage` (T186: both BR-BCT and MB1-BCT, validated end-to-end against the shipped p2771 package)
- `RcmFlasher` — the full flash flow: read UID → program BCT → stream boot images → download-and-execute (T210/T186), or the T194 applet hand-off (read UID → query version → download-and-execute, all `tegrarcm_v2 --chip 0x19` sends at the RCM level), with progress reporting

SDRAM parameters compile straight from the board's `.cfg` via `parseSdramCfg` (T210 `T210_SDRAM_CFG_LAYOUT`, T186 `T186_SDRAM_CFG_LAYOUT`) — feed the packed sets to `serializeBct` (T210) or `patchMb1BctSdram` (T186). Pre-packed bytes from a template BCT still work where you have them.

## Install

```sh
pnpm add libtegrarcm
```

## Usage

Put the device into RCM/APX mode first (Jetson: hold `FRC REC` + tap power; confirm the host logs `Product: APX`). WebUSB requires a user gesture and a secure context.

### Read the chip UID

```ts
import { requestDevice } from 'libtegrarcm'

const device = await requestDevice({ logging: true })
await device.connect()
const uid = await device.readUid() // 16-byte ECID
```

### Full RCM flash (Jetson)

```ts
import { RcmFlasher, serializeBct, signBct } from 'libtegrarcm'

const flasher = new RcmFlasher(device, {
  onProgress: (p) => console.log(p.stage, p.bytesTransferred, p.totalBytes)
})

const bct = serializeBct({/* board config: block/page/partition, sdram, bootloaders */})
await signBct(bct) // zero-key (SBK) AES-CMAC; swap in RSA-PSS for PKC-fused devices

await flasher.flash({
  bct,
  bootImages: [/* nvtboot, cboot, ... */],
  executePayload: bootloaderStub
})
```

### Flash a whole board package

`buildV1BootPackage` (T124/T132/T210) and `buildV2BootPackage` (T186) turn an untarred `*_flash_package.txz` into a flashable boot package — BCT(s), boot images, and applet — with no NVIDIA host tool. Decompress the `.txz` yourself (`xz`), then:

```ts
import { buildV2BootPackage, constants, parseFlashPackageTar, RcmFlasher } from 'libtegrarcm'

const pkg = parseFlashPackageTar(tarBytes) // pkg.chip === 'T186'
const boot = buildV2BootPackage(pkg) // both BCTs, byte-identical to tegrabct_v2

const flasher = new RcmFlasher(device, { chip: constants.Chip.T186 })
await flasher.flash(boot) // streams BR-BCT + MB1-BCT (boot.bcts), then boot images, then the applet
```

On T194 the RCM stage is just the applet hand-off (the rest of flashing runs through the downloaded applet):

```ts
const flasher = new RcmFlasher(device, { chip: constants.Chip.T194, queryVersion: true })
await flasher.flash({ executePayload: mb1RecoveryBin })
```

Messages default to the **zero-key (SBK)** signer; pass a custom `signer` for PKC/RSA-fused parts.

## Caveats

- WebUSB is Chromium-only, over HTTPS (or `localhost`).
- On Linux, grant device access with a udev rule:

  ```
  SUBSYSTEM=="usb", ATTR{idVendor}=="0955", MODE="0666"
  ```

- Tegra recovery devices are **serial-less**, so the browser may drop the WebUSB grant when the device re-enumerates after boot. Recover by calling `requestDevice()` again from a user gesture (surfaced as `ReacquireNeededError`).

## Status

- **T210**: RCM messages, BCT layout, SDRAM `.cfg` compilation, and SBK signing match the real NVIDIA tools (see [PROTOCOL.md](./PROTOCOL.md#supported-features)).
- **T186**: RCM messages, **whole BR-BCT and MB1-BCT** (`buildV2BootPackage`, byte-identical to `tegrabct_v2` from the shipped p2771 package), SDRAM `.cfg` compilation, and the SBK RCM CMAC match the NVIDIA tools. `RcmFlasher` streams both BCTs via the program-BCT path.
- **T194**: RCM messages match `tegrarcm_v2 --chip 0x19`; `RcmFlasher` drives the RCM-level applet hand-off (query version → download-and-execute). The RCM `ProgramBct`/`ProgramBootloader` wire opcodes are unknown and rejected — on T194 flashing continues through the downloaded applet, not bootrom RCM.
- **T234/T264 (Orin/Thor)**: `serializeMb1NvHeader` matches `tegrahost_v2 --addmb1nvheader` (unsigned dev path, both chips). RCM framing has no host-buildable form (see [PROTOCOL.md](./PROTOCOL.md)), so the flash flow targets T210/T186/T194.
- Real-hardware end-to-end flashing still needs a device in APX mode.

## Development

```sh
pnpm install
pnpm build        # tsdown
pnpm type-check   # tsc
pnpm lint         # eslint
pnpm test         # vitest (asserts against real-tool golden buffers)
```

An `example/` Vue app demonstrates connect → read UID → flashing straight from a board's `*_flash_package.txz` (xz-decompressed and assembled into a boot package in the browser).

### Adding a chip

Chip support hangs off one `ChipProfile` entry in `src/chips.ts` (RCM codec, BCT layouts, SDRAM cfg layout, applet address). The layout data comes out of the chip's own flash-package binaries, not hand reverse-engineering: `tools/extract-chip-tables.ts --fields-only <tegrabct>` dumps the tool's internal name→offset parse tables, and `sdramCfgLayoutFromTable` turns a dumped table straight into a `parseSdramCfg` layout. Golden fixtures for the new chip come from its package via a `tools/regenerate-*.sh` script.

Protocol internals, byte layouts, and how the golden fixtures are regenerated from the NVIDIA binaries: **[PROTOCOL.md](./PROTOCOL.md)**.
