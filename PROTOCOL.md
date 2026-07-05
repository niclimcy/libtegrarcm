# Tegra RCM protocol

Protocol details behind `libtegrarcm`, recovered from NVIDIA's `tegraflash` binaries (`llvm-objdump`/`llvm-nm` on the 32-bit i386 ELFs in `tegraflash/`) and the Python/shell scripts in NVIDIA's flash packages — `tegrasign_v3*.py` (signing) and `helpers.sh` (flashing script library, source of the `APXPRODUCT` PID→chip map below). T210 facts come from the p3450 (Jetson Nano) package, T186 from the quill (Jetson TX2) package. Struct layouts come from disassembly plus the public `nvboot_rcm.h`/cbootimage/`tegrasign_v3` sources. Everything is validated against the real tools — see [Supported features](#supported-features).

## USB

- Vendor id `0x0955` (NVIDIA). Product id varies per chip, so the WebUSB filter uses vendor id only (`src/constants.ts` `DeviceFilters`).
- RCM/APX product ids (`APXPRODUCT` in `helpers.sh`), for identifying the connected chip:

  | chip        | chip id | PID(s)                                      |
  | ----------- | ------- | ------------------------------------------- |
  | T210        | `0x21`  | `0x7721`                                    |
  | T210 (Nano) | `0x21`  | `0x7f21`                                    |
  | T186        | `0x18`  | `0x7c18`                                    |
  | T194        | `0x19`  | `0x7019`                                    |
  | T194 NX     | `0x19`  | `0x7e19`                                    |
  | T234 (Orin) | `0x23`  | `0x7023 0x7223 0x7323 0x7423 0x7523 0x7623` |
  | T264 (Thor) | `0x26`  | `0x7026`                                    |

- Recovery matching is `vid == 0x0955 && (pid & 0xF0FF) == <base>` — the pidmask ignores the board-variant middle nibble, so the six T234 pids all collapse to `0x7023`. Cross-checked against L4T R39.2.0 (Thor BSP): `_nv_base_orin_target` uses pid `0x7023` / `--chip 0x23`, `_nv_base_thor_target` pid `0x7026` / `--chip 0x26`, and `recovery_status(pid, pidmask=0xF0FF)`. (The R32.1.0 package predates the shipped `APXPRODUCT` table, so the older pids come from newer L4T `helpers.sh`.)

- Transport is a bulk IN/OUT endpoint pair (`NvTegraUsbWrite`/`NvTegraUsbRead`); no vendor control transfers in the message path (`src/transport.ts`).
- Handshake (`NvTegraRcmInitBootRomCommunication`): read the 16-byte chip UID first (skipped with `--skipuid`), then per message `bulkOut(message)` → `bulkIn(4)` status → next.

## Applet load address (`NvTegraRcmGetAppletAddress`)

From the `NvTegraRcmGetAppletAddress` jump table: T132 (`0x13`) → `0x4000F000`; T210 (`0x21`) → `0x40010000` (also the default); T186/T194/T234 (`0x18`/`0x19`/`0x23`) → `0x40020000`. This is the value `tegrarcm_v2 --download rcm` substitutes when passed a zero load/entry (confirmed by `EntryAddress` in the T186 and T194 RCM goldens).

## RCM message — T210 (`NvTegraT21xRcmCreateMsgFromBuffer`)

Implemented in `src/rcm/v1.ts`. All multi-byte fields little-endian.

| offset  | field                                                    |
| ------- | -------------------------------------------------------- |
| `0x000` | `LengthInsecure` (u32, total message length)             |
| `0x004` | RSA modulus + PSS signature + object hash (signing)      |
| `0x238` | `RandomAesBlock` — start of the signed region            |
| `0x258` | `Opcode` (u32)                                           |
| `0x25c` | `LengthSecure` (u32, == LengthInsecure)                  |
| `0x260` | `PayloadLength` (u32)                                    |
| `0x264` | `RcmVersion` = `0x00210001` (u32)                        |
| `0x268` | `EntryAddress` (u32)                                     |
| `0x2a0` | fixed `0x00000080`                                       |
| `0x2a8` | payload (ISO-7816 `0x80` marker after data, zero-padded) |

- Header is `0x2A8` bytes (680); total length = `0x2A8 + payloadLength`, padded to a 16-byte boundary. Small payloads produce a fixed 1032-byte (`0x408`) message.
- Two format paths: generic `NvTegraRcmCreateMsgFromBuffer` and T210's `NvTegraT21xRcmCreateMsgFromBuffer`; `NvTegraT21xRcmGetOffsetSize` dispatches through a 7-entry (opcode 0..6) jump table. `NvTegraComputeChecksum` is a plain 8-bit byte sum.

## RCM message — T186 (`tegrarcm_v2 --chip 0x18`)

Implemented in `src/rcm/v2.ts` (`buildT186RcmMessage`). Same secure-header field structure as T210 but a larger `0x520`-byte insecure header (the v2 signature/key block) and the payload at `0x5B0`. All multi-byte fields little-endian.

| offset  | field                                                    |
| ------- | -------------------------------------------------------- |
| `0x000` | `LengthInsecure` (u32, total message length)             |
| `0x004` | RSA modulus + PSS signature + object hash (signing)      |
| `0x520` | `RandomAesBlock` — start of the signed region            |
| `0x540` | `Opcode` (u32)                                           |
| `0x544` | `LengthSecure` (u32, == LengthInsecure)                  |
| `0x548` | `PayloadLength` (u32)                                    |
| `0x54c` | `RcmVersion` = `0x00180001` (u32)                        |
| `0x550` | `EntryAddress` (u32, default `0x40020000`)               |
| `0x5a4` | fixed `0x00000080`                                       |
| `0x5b0` | payload (ISO-7816 `0x80` marker after data, zero-padded) |

- Header is `0x5B0` bytes (1456); total = `alignUp(0x5B0 + payloadLength + 1, 16)` (the `+1` is the `0x80` marker). No fixed small-message floor, unlike T210: a 256-byte `0xAA` payload gives `0x6C0` (1728), an empty message `0x5C0` (1472).
- Signed region is `[0x520, end)` — matches `tegrarcm_v2 --listrcm`'s reported offset 1312.
- Opcodes are remapped per chip (`NvTegraT18xRcmMapOpCode`): download-and-execute is wire opcode `4` (same as T210), but the version query is wire opcode `7` (normalizes to logical `6`; confirmed by the `t186_rcm_0.rcm` golden's opcode field). `t186WireOpcode` applies the query remap inside `buildT186RcmMessage`; other logical opcodes pass through unremapped (their T186 wire values are unobserved).

## RCM message — T194 (`tegrarcm_v2 --chip 0x19`)

A distinct, larger layout from T186, with its own `NvTegraT19xRcmCreateMsgFromBuffer` / `NvTegraT19xRcmGetOffsetSize`. Recovered from `tegrarcm_v2 --chip 0x19 --listrcm` (`tests/golden/t194_rcm_{0,1}.rcm`, `regenerate-t194.sh`, from the R32.1.0 combined T18x/T19x BSP) and cross-checked against the disassembled builder. All fields little-endian.

| offset  | field                                               |
| ------- | --------------------------------------------------- |
| `0x000` | `LengthInsecure` (u32, total message length)        |
| `0x004` | RSA/key + object-hash region (signing)              |
| `0x4c4` | 32-byte hash — present even in the unsigned message |
| `0x6d0` | `Opcode` (u32)                                      |
| `0x6d4` | `LengthSecure` (u32, == LengthInsecure)             |
| `0x6d8` | `PayloadLength` (u32)                               |
| `0x6dc` | 32-byte per-payload block (download message only)   |
| `0x6fc` | `RcmVersion` = `0x00190001`                         |
| `0x700` | `EntryAddress` (u32, default `0x40020000`)          |
| `0x798` | fixed `0x80000000`                                  |
| `0x7b0` | payload (no ISO-7816 `0x80` marker)                 |

- Header is `0x7B0` bytes (1968); total = `0x7B0 + payloadLength` exactly — no `0x80` marker and no 16-byte alignment (T210/T186 have both). An empty message is `0x7B0`, a 1-byte payload `0x7B1`, a 256-byte `0xAA` payload `0x8B0` (2224).
- Opcodes differ: download-and-execute is wire opcode `5` (T210/T186 use `4`); the version query is `7` (as on T186; `6` on T210). Captured as `T194RcmOpcode` — `RcmOpcode` is the T210/v1 enumeration and does not carry over. The `ProgramBct`/`ProgramBootloader` wire values aren't in the `--listrcm` goldens, so full-flash opcode coverage is still open; `t194WireOpcode` maps the two known logical opcodes and throws for the rest.
- The T194 flash flow is the applet hand-off — read UID → (query version) → download-and-execute the applet — which is everything `tegrarcm_v2 --chip 0x19` ever sends at the RCM level (its two `--listrcm` messages are exactly the query and the download); flashing proper continues through the downloaded applet, not bootrom RCM. `RcmFlasher.flash` drives this for a package with only `executePayload`; a package carrying a `bct`/`bootImages` is rejected on T194 (unknown wire opcodes) rather than guessed.
- Applet load address `0x40020000` (same as T186/T234), substituted for a zero entry — confirmed by `EntryAddress` @`0x700`.
- Two SHA-256 fields are part of the message, not the signature: `0x6dc` is `SHA-256(payload)` (zero for an empty payload), and `0x4c4` is `SHA-256` of the 256-byte secure header `[0x6b0, 0x7b0)` (which includes the payload hash, so it's computed last). `buildT194RcmMessage` reproduces both — `tests/rcm.test.ts` matches `t194_rcm_{0,1,p1}.rcm` byte-for-byte across three payload sizes.
- Signing covers only the 256-byte secure header `[0x6b0, 0x7b0)` (`rcm_list.xml` reports offset 1712, length 256 for every message); the payload is bound through its digest at `0x6dc`, so signing does not re-hash it. `t194SecureRange` returns this window.

T186/T194/T234 form one v2 family and T210 is v1: `tegraflash_internal.py` branches on `chip in [0x18, 0x19, 0x23]`, one `bootloader/t186ref/` tree holds both `tegra186-*` and `tegra194-*` fragments, and only `tegrabct_v2`/`tegrarcm_v2`/`tegrasign_v2` ship (T210 uses `t210ref`, `tegrabct`).

### T234 / T264 (chip `0x23` / `0x26`) — no host-buildable RCM frame

The host `tegrarcm_v2` never carries an RCM message layout for T234 or T264, so
their frames cannot be recovered the way T186/T194 were. Confirmed by
disassembling both the R39.2.0 (JetPack 7.2) and R35.6.4 (JetPack 5.1.6)
binaries — in each, the sole message producer `NvTegraRcmGenRcm` calls
`NvTegraRcmCreateMsgFromBuffer`, whose chip dispatch compares only
`0x19`/`0x21`/`0x18` (→ `NvTegraT{19,21,18}xRcmCreateMsgFromBuffer`) and otherwise
returns error `4` without building anything. `CreateMsgPadding` and `MapOpCode`
hard-code the same three ids; there is no `NvTegraT23x*`/`NvTegraT264*` Rcm symbol
in either binary. `NvTegraRcmGetAppletAddress` does map `0x23`→`0x40020000` (and
R39 additionally recognizes but has no `0x26` case), but the applet-address map is
consulted independently of message building — a known chip id there does not imply
a buildable frame.

This holds even for R35.6.4, which flashes Orin (T234): its `0x23` still falls
through the builder dispatch to the error return. So Orin/Thor recovery bring-up
does not use a precomputed static download-and-execute message at all — it runs
through the live-device MB2-applet path (`tegrarcm_applet.c`:
`NvTegraRcmIsMb2Applet`, `NvTegraRcmAppletDownload`), where the boot ROM is driven
interactively over USB. There is no offline artifact to golden.

Consequence: T234/T264 RCM cannot be mapped from any BSP binary (R32/R35/R39 all
build only `0x18`/`0x19`/`0x21`). Mapping them would require a USB capture of a
live `tegrarcm_v2` session against real Orin/Thor hardware.

### T234 / T264 MB1 NV header (`tegrahost_v2 --addmb1nvheader`)

While `tegrarcm_v2` has no T234/T264 message builder, `tegrahost_v2` (the
BSP's boot-image builder/signer, also unstripped) builds this fixed-size
wrapper — a different, smaller artifact than T186's BR-BCT/MB1-BCT (which is
a single self-contained, SDRAM-cfg-bearing blob); the T234/T264 SDRAM/board
config equivalent is not mapped by this work.

`--addmb1nvheader` runs a **two-function pipeline** in `main` (dispatch traced
statically and confirmed by a magicid-matrix run of the real tool under docker):

1. `main → NvTegraHostAddMb1NvHeaderCore → NvTegraT23xFillMb1NvHeader` (T264:
   `NvTegraT264FillMb1NvHeader`; `AddMb1NvHeaderCore` dispatches per chip).
   `Fill` mallocs a fresh `headerSize`-plus-payload buffer — `headerSize` a
   per-chip _constant_ from a no-argument size call, not derived from the
   payload — zero-fills it, copies the raw payload in at `headerSize`, writes
   `NVDA`, and builds **`stage1`** from scratch: magic from `--magicid`,
   `payloadSize` from a caller-supplied length, `loadAddress`/`secondAddress`/
   flags from a per-name `strncmp` chain (see the table below), then
   `NvTegraSha512(payload = header_base + headerSize, length = payloadSize,
dest = stage1_base + 0x50)`, and saves. It never touches `stage0`.
2. `main → NvTegraHostAppendHeader → NvTegraHostAppendT23xHeader` (T264:
   `…AppendT264Header`). `AppendHeader` is the generic dispatcher; it reaches
   the chip-specific function by a **`jmp` tail-call**, not a `call` — which is
   why a search for direct call sites to `AppendT23xHeader` finds none, and why
   an earlier pass wrongly concluded it was the _sole_ implementer (and, in a
   later over-correction, that `Fill` was unreachable). `AppendT23xHeader` reads
   the file `Fill` just wrote, leaves the existing `stage1` alone, and builds
   **`stage0`** from it (plus the outer-header signature), then saves.

The two `NvTegraSaveFile` calls — one per stage — writing the same output file
are what an `inotifywait` trace of a real run observed as "one file, written
twice". So `Fill` is the sole source of the stage1 address table; `Append` only
mirrors it into `stage0`.

Implemented in `src/bct/v2/mb1NvHeader.ts` (`parseMb1NvHeader`,
`serializeMb1NvHeader`, `T234_MB1_NV_HEADER_LAYOUT`, shared by chip `0x23` and
`0x26` — the _file-level_ layout, i.e. header size and both components'
offsets, is identical between them; the per-chip `--magicid` dispatch is not —
see below). `serializeMb1NvHeader` is the pure-TS replacement for
`tegrahost_v2 --addmb1nvheader <file> nvidia-rsa`: it rebuilds the whole header
(`NVDA`, both descriptors with the per-chip address table, the two outer
SHA-512s) with no NVIDIA binary, and is validated **byte-for-byte** against
every committed golden (both chips, addressed/flags-only/unrecognized magic
ids). It reproduces the _unsigned_ dev path — a PKC/SBK-fused part still needs
the board's OEM key, exactly as the real flow splits header-build from signing.
Derived from and cross-checked against:

1. `tegraflash_impl_t234.py` (plaintext Python shipped in the BSP), which
   hardcodes absolute byte offsets into the built file for its AES-GCM
   encryption step: `aad1_offset=7904` (the whole `stage1_components[0]`
   descriptor, comment confirms the name), `ver_offset=7920`,
   `der_str_offset=7936`, `iv1_offset=7956`/`tag1_offset=7968`
   (`enc_params.u8_iv`/`u8_auth_tag`), `sha_offset=7984`.
2. `NvTegraHostAppendT23xHeader`'s disassembly (see above).
3. Running the real tool (`--align` then `--chip <0x23|0x26> 0 --ratchet 0 0
--magicid <name> --addmb1nvheader <file> nvidia-rsa` — see
   `tools/regenerate-t234-mb1header.sh`) against synthetic payloads of
   several sizes/chip ids/magic ids: total header size held at `0x2000`
   regardless of payload size or chip; every offset held constant; the
   embedded SHA-512 digest tracked each run's payload exactly (verified
   against `crypto.subtle.digest`); the load-address field's value was
   independently echoed by the tool's own log line (`Updating MB1 load
destination addresss: 0x...`); and `--magicid PSCB`, an unrecognized name,
   and `--magicid TSEC` (see below) each produced the expected output (see
   `mb1NvHeader.test.ts`).

Layout (offsets relative to each component descriptor's base):

| field             | offset                  | notes                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| magic             | `0x00` (4 bytes)        | copied from the `--magicid` string's first 4 bytes for any recognized or unrecognized name alike                                                                                                                                                                                                                                                                                                                 |
| payloadSize       | `0x04` (u32)            |                                                                                                                                                                                                                                                                                                                                                                                                                  |
| loadAddress       | `0x08` (u32)            | hardcoded per recognized component name at _creation_ time — see table below and the real-image caveat further down                                                                                                                                                                                                                                                                                              |
| secondAddress     | `0x0c` (u32)            | a second, independently-hardcoded address — confirmed distinct from `loadAddress` (`PSCB` sets `0x00120000`/`0x00120400`, two different values); exact semantics (true entry address vs. a second image region) not determined                                                                                                                                                                                   |
| flag bytes        | `0x10`-`0x11` (2 bytes) | at creation time, both bytes are written together as `(1, 1)` iff `--magicid` matched a known name, else `(0, 0)` — **not a version number**, despite `tegraflash_impl_t234.py` documenting a "VER" value at the same relative position for a different purpose. Real signed images don't preserve this — see the caveat below, which is why `parseMb1NvHeader` exposes these as raw bytes rather than a boolean |
| derivation string | `0x20` (16 bytes)       | AES-GCM key derivation string; zero when unencrypted, genuinely non-zero and real in both factory-signed images checked (see below)                                                                                                                                                                                                                                                                              |
| IV                | `0x34` (12 bytes)       | AES-GCM IV; same — zero when unencrypted, real in signed images                                                                                                                                                                                                                                                                                                                                                  |
| auth tag          | `0x40` (16 bytes)       | AES-GCM tag; same                                                                                                                                                                                                                                                                                                                                                                                                |
| SHA-512 digest    | `0x50` (64 bytes)       | **stage1 only** — see below                                                                                                                                                                                                                                                                                                                                                                                      |

`NvTegraT23xFillMb1NvHeader` recognizes six `--magicid` values
(`KNOWN_COMPONENT_MAGICS` in `mb1NvHeader.ts`) via a plain `strncmp` if-else
chain (PIC base `0x80dd530`), each getting its own hardcoded `loadAddress`/
`secondAddress` _at creation time_. Fully decoded from the disassembly and
reproduced exactly by the real tool for every entry (docker magicid matrix):

| magic  | loadAddress  | secondAddress | flag bytes |
| ------ | ------------ | ------------- | ---------- |
| `MB1B` | `0x50000000` | `0x50000000`  | `(1,1)`    |
| `PSCB` | `0x00120000` | `0x00120400`  | `(1,1)`    |
| `PSCR` | `0x00120000` | `0x00120400`  | `(1,1)`    |
| `WB0B` | `0x40040000` | `0x40040000`  | `(1,1)`    |
| `BPMF` | `0x0`        | `0x0`         | `(1,1)`    |
| `PFWP` | `0x0`        | `0x0`         | `(1,1)`    |

Any other name leaves both addresses and the flag bytes at their zero-filled
defaults (confirmed against the real tool with an unrecognized `XXXX` magic
id). `MBCT` is **not** in this list — despite `AppendT23xHeader` carrying a
literal `MBCT → 0x40040000`, that stage1-build path is dead in the CLI flow
(see below), so `--magicid MBCT` empirically yields zero addresses, flags
`(0,0)`.

**T264 (`NvTegraT264FillMb1NvHeader`, chip `0x26`) uses a different table**
(`T264_COMPONENT_MAGICS`), also fully decoded and matrix-confirmed:

| magic  | loadAddress  | secondAddress |
| ------ | ------------ | ------------- |
| `MB1B` | `0x50000000` | `0x50000000`  |
| `PSCB` | `0x00110000` | `0x00120400`  |
| `WB0B` | `0x40040000` | `0x40040000`  |

The `PSCB` `loadAddress` is `0x110000`, **not** the T23x `0x120000`
(`secondAddress` is the shared `0x120400`) — the one genuine divergence between
the two chips' address tables, locked by `t264_mb1_nvheader_pscb.bin`. There is
no `PSCR` on T264. Ten further names get flags `(1,1)` with zero addresses:
`BPMF`, `PFWP`, `MINF`, `TSEC`, `GBFW`, `BIST`, `HPLD`, `HPFW`, `SBLD`, `SBFW`
(13 recognized names total).

### Two independent name-lists, and the stage0-mirroring mechanism

`stage0` is built by `NvTegraHostAppendT23xHeader` (the pipeline's second
stage), reading the `stage1` that `Fill` already wrote. Mechanism,
confirmed by disassembly plus a docker `--magicid` matrix (`MB1B`, `PSCB`,
unrecognized `XXXX`, `TSEC`):

- **Copy-vs-generic gate** — a **12-name** list: `MBCT`, `MB1B`, `MTSP`,
  `MTSM`, `WB0B`, `PSCB`, `BPMF`, `PFWP`, `PSCR`, `TSEC`, `NDEC`, `XUSB`. If
  `--magicid` matches one of these, `stage0` is built by an **explicit,
  field-by-field copy from stage1**: magic, `payloadSize` (written to _both_
  `0x04` and `0x20` within `stage0` — this is the "second copy of
  payloadSize" noted below), the flag bytes plus two further bytes at
  `0x12`-`0x13` (previously assumed reserved), `loadAddress`, and
  `secondAddress` — all copied verbatim, one dword/byte `mov` per field, from
  the already-built `stage1`.
- If `--magicid` does _not_ match any of those 12 names, a **different,
  generic path** computes `stage0` instead: `payloadSize` is written
  directly (not copied from stage1) at an offset selected by `index * 0xa0`
  where `index` (0 or 1) comes from absolute file offset `0xfe0`; `magic` is
  either the raw `--magicid` bytes or an `sprintf`-generated name depending on
  a further internal check; the flag bytes are explicitly zeroed; and one
  extra byte is the sum of two parameters.
- **Separately**, the **6-name** address list above lives in `Fill`
  (`NvTegraT23xFillMb1NvHeader`), not `Append`, and governs `stage1`'s
  `loadAddress`/`secondAddress`. This is a _different_ list from the 12-name
  copy gate — proven by `TSEC`: it's in the 12-name copy list but _not_ the
  6-name address list, so a `--magicid TSEC` build gets zero addresses (like an
  unrecognized name, from the address list's perspective) while `stage0` still
  faithfully mirrors `stage1` (like a recognized name, from the copy gate's
  perspective) rather than falling back to the generic path. A name can be in
  one list, the other, both, or neither.
- The stage1 address mechanism is that `strncmp` chain in `Fill` — **not** a
  data-table lookup, as an earlier pass hypothesized after finding no address
  literals in `AppendT23xHeader`. The literals are simply in a _different_
  function (`Fill`), plus `MBCT`'s `0x40040000` in `Append`'s own
  (CLI-unreached) stage1 path.
- `NvTegraT264FillMb1NvHeader` carries the T264 address table
  (`T264_COMPONENT_MAGICS`) — `MB1B`/`WB0B` matching T23x, `PSCB` diverging to
  `0x110000`, and ten flags-only names — while `NvTegraHostAppendT264Header`
  carries T264's own 13-name copy gate: `MB1B`, `PSCB`, `WB0B`, `BPMF`, `PFWP`,
  `MINF`, `TSEC`, `GBFW`, `BIST`, `HPLD`, `HPFW`, `SBLD`, `SBFW` (notably no
  `PSCR`). The overall _file_ layout (header size,
  `stage0`/`stage1` offsets, field offsets within a component) is identical
  between the two chips regardless — only the per-magic-id tables differ.

### BSP

The R39.2.0 BSP ships `bootloader/mb1_{t234,t264}_prod.bin` — genuine signed
MB1 boot images (proprietary NVIDIA firmware, not committed to this repo as a
golden fixture). Both start with
the same `NVDA` magic and have `MB1B` at the same `stage0`/`stage1` offsets as
every synthetic golden; `payloadSize` matches each file's actual size minus
`0x2000` exactly; the SHA-512 digest matches each file's real (much larger)
payload; and — unlike the synthetic goldens, which use the unsigned
`nvidia-rsa` dev path — the derivation-string/IV/auth-tag fields are
genuinely non-zero real AES-GCM data. This independently confirms every
offset in the field table above.

Both images' `loadAddress`/`secondAddress` and flag-byte values
**differ** from what `--addmb1nvheader` produces standalone, however. The T264 image's `MB1B` component has `loadAddress=0x7fec0000`, not the
table's `0x50000000` — even though a synthetic `--addmb1nvheader` run on the
same tool reproduces `0x50000000` exactly. The flag bytes similarly don't
match: creation-time gives `(1, 1)`, but the real T234 image shows
`(1, 0x17)` and the real T264 image shows `(0, 0x25)` — for components whose
magic clearly _is_ `MB1B`. So some later step in the real flash pipeline
overwrites `loadAddress`/`secondAddress` and the flag bytes after
`--addmb1nvheader` builds its creation-time defaults; that step is not
identified (`tegrahost_v2`'s `--ratchet <nv> <oem>` mode, documented as
updating "nv & oem ratchet versions in nvidia sigheader," only accepts the
two numeric args with no file argument slot, so it is not a standalone
post-hoc patch command). Treat `KNOWN_COMPONENT_MAGICS` and the flag-bytes
field as `tegrahost_v2`'s own creation-time default, not as ground truth for
what a real signed image contains.

The file has two component descriptors: `stage0` at `0x1400` and `stage1` at
`0x1ee0` (`stage0ComponentOffset`/`stage1ComponentOffset`). Only `stage1`
matches the field table exactly (and is what both `tegraflash_impl_t234.py`
and `NvTegraHostAppendT23xHeader` directly write). `stage0`'s construction —
copy from stage1 for a 12-name list, or computed generically otherwise — is
covered in full above ("Two independent name-lists, and the stage0-mirroring
mechanism"); `parseMb1NvHeader` reads `stage0`'s digest from the correct
(`0x60`, not `0x50`) offset, confirmed against multiple synthetic payloads
and both real production images.

`tegrahost_v2` logs `Header already present for <output-file>` on every run
of `--addmb1nvheader`, including a from-scratch build — checked against the
not-yet-written output path. This is benign tool chatter, not a skip: the
SHA-512-of-payload and payload-size fields reliably tracked each run's input,
confirming a fresh header is written every time.

## BCT — T210 (`tegrabct --chip 0x21`, `0x2800` bytes)

Implemented in `src/bct/v1.ts` (`T210_BCT_LAYOUT`).

- Total size `0x2800` (10240 bytes).
- Signed section `[0x510, 0x2800)` (offset 1296, length 8944). AES-CMAC / RSA-PSS covers this range; the 16-byte SBK CMAC is written at BCT offset `0x00`.
- SDRAM param array: first set at `0x58c`, stride `0x768`, 4 sets — ends at `0x58c + 4*0x768 = 0x232c`, exactly where the bootloader table begins.
- Header scalars (populated by `--updatedevparam`/`--updateblinfo`): bootDataVersion @`0x530` (`0x00210001`), blockSizeLog2 @`0x534` (`0xe`), pageSizeLog2 @`0x538` (`9`), partitionSize @`0x53c`, NumParamSets @`0x540` (`1`), devType @`0x544`, DevParams @`0x548`, NumSdramSets @`0x588`, odmData @`0x508`, uniqueChipId @`0x520`.
- `NvBootDevType` (devType @`0x544`): `spi` → `3`, `sdmmc`/eMMC → `4`. Encoded as `BootMedium` in `src/bct/v1.ts`.
- `NumSdramSets` @`0x588` is left 0 by `tegrabct` even when four SDRAM param sets are written — confirmed on the p3448 BCT and by disassembly (`NvTegraParseSdRamParams` writes the param data but never the count). The bootrom selects the set by strap/odmdata, not this count, so `serializeBct` likewise leaves it 0.
- Bootloader table: `bootLoadersUsed` @`0x232c`, `BootLoaderInfo[]` @`0x2330`, entry stride `0x12c`, 4 entries; `secureDebugControl` @`0x27e4`.

## BCT — T186 (`tegrabct_v2 --chip 0x18`)

Implemented in `src/bct/v2/brBct.ts` + `src/bct/v2/mb1Bct.ts`. Unlike T210's single flat BCT, T186 splits boot config into two little-endian structures assembled by `tegrabct_v2`.

### BR-BCT (`--brbct`, `0xe00` bytes)

- Total size `0xe00` (3584 bytes), self-reported @`0x0` (u32).
- Signed section `[0x680, 0xe00)` (offset 1664, length 1920), per `tegrabct_v2 --listbct`. Unlike T210, `flash.sh` leaves this un-hashed for zero-key devkits.
- Byte-identical between the P2771 and P3636-P3509 goldens, and otherwise all zeros except the fields below — its SDRAM section carries no `EmcClockSource` marker (unlike the MB1-BCT). Assembled from `--dev_param emmc.cfg` (+ `--sdram`, + an empty `br_bct.cfg`).
- `odmData` (u32) @`0x678`. Left 0 by `regenerate-t186.sh` (no `--odmdata`); `flash.sh` bakes the computed value at flash time.
- Dev params from `emmc.cfg`: `blockSizeLog2` @`0x6a4` (= `log2(BlockSize)`), `pageSizeLog2` @`0x6a8` (= `log2(PageSize)`), `PartitionSize` @`0x6ac`, `BootLoader[0].Version` @`0x6fc`, `.EntryPoint` @`0x70c`, `.LoadAddress` @`0x710`.
- Fixed init constants (from an empty `br_bct.cfg`, board- and cfg-invariant): `0x00180001` @`0x6a0` (eMMC `NvBootDevParams` header, chip `0x18`/version 1); `0x01010101 0x01010100 0x01010101 0x00000101` @`0xd44`; `0x00000080` @`0xd8c`.

### MB1-BCT (`--mb1bct`, board-variable size)

- Header scalars: self-reported total size @`0x0` (u32), format version @`0x4` (u32, `0xf`).
- SDRAM param array: first set @`0xbb0`, stride `0x12b0`, 4 sets (`patchMb1BctSdram`) — ends at `0xbb0 + 4*0x12b0 = 0x5670`. (`EmcClockSource` `0x40008002` sits `0xc0` into each packed instance, so its four occurrences on the stride pin the offsets independently.)
- Full region map (from `tegrabct_v2`'s own `s_Mb1BctFields` struct table + the `NvTegraT18xPackSdramParams` disassembly):
  - `[0x0, 0x4)` self-reported total size; `[0x4, 0xbb0)` header — see the `misc` bullet.
  - `[0xbb0, 0x5670)` SDRAM param sets — 4 × stride `0x12b0` (field id `0x00` in `s_Mb1BctFields`), from the `.sdram` cfg.
  - `[0x5670, 0x7cc0)` packed SDRAM boot-scratch — 4 × `0x994` (one per SDRAM set), the BR/SC7 warmboot register image `NvTegraT18xPackSdramParams` bit-packs from each SDRAM set. Not a cfg fragment: it's a memory-type-specific hand-unrolled prefix (branches on `MemoryType` = SDRAM field `@0x0`; `3` = LpDdr4, `1` = LpDdr2 share one path, `2` = Ddr3 another) followed by four generic controller-map tables, applied in order. Each table row is `{u16 dest, u16 pad, u32 srcMask, i16 shift, u16 srcOff}`: `scratch[dest] = (scratch[dest] & ~(srcMask«shift») ) | ((sdramSet[srcOff] & srcMask)«shift»)`, where `shift` is signed (high bit set ⇒ shift right by `−shift`; x86 masks the count to 5 bits). The four tables hold 1665 + 654 + 1 + 27 = 2347 rows in `tegrabct_v2`'s `.text` (extracted by `tools/extract-mb1-scratch.ts`). A scratch register offset maps to a block byte offset through two windows — `[0x64,0x570]→block[0x420+off]`, `[0xae4,0xf64]→block[off−0xae4]` (both compares unsigned) — and a dest outside both windows is silently dropped.
  - `[0x7cc0, 0x7d18)` fragment directory (field id `0x50`, `0x58` bytes): `u16 type=2, u16 pad, u32 count=10`, then 10 × `{u32 offsetFromFragBase, u32 size}`. Fragment base = `0x7d18`. Slot order is fixed by fragment _type_ — `[pinmux, scr, pad, brcommand, pmic, prod, 0,0,0,0]` — but the `offset` fields encode the on-disk order, which differs (pmic precedes brcommand physically).
  - `[0x7d18, EOF)` the platform-config fragments: back-to-back `[version u32][count u32][entries…]`, `version = (major<<16)|minor`. Physical order on P2771: `pinmux`@`0x7d18` (v1.0, 378) → `scr`@`0x88f0` (v4.3, 2878) → `pad`@`0xb8c0` (v1.0, 2) → `pmic`@`0xb8d8` (v1.2, 169) → `brcommand`@`0xbb84` (v1.0, 14) → `prod`@`0xbbc4` (v1.0, 135) → EOF.
- Register-list fragments (`pinmux`/`pad`/`prod`): `pinmux`/`pad` are `[addr, value]` pairs (cfg namespace `pinmux`/`pmc`), `prod` is `[addr, mask, value]` triples.
- `scr` (security-config-register) fragment `[0x88f0, 0xb8c0)`: `{4.3, count 2878}`, then the 2878 values as u32s `[0x88f8, 0xb5f0)`, then a 2-bit-per-entry code array `[0xb5f0, 0xb8c0)` (`⌈2878/4⌉ = 720 = 0x2d0` bytes). That trailing array is the `scr.<n>.<m>` `<m>` suffix packed little-endian, 2 bits per entry in index order (values 0..3). The fragment directory's scr-slot size (`0x2fd0`) is the value array + code array together.
- `pmic` (`parsePmicCfg` + `packPmicFragment` in `src/bct/v2/pmic.ts`, validated against `[0xb8d8, 0xbb84)`): `{1.2, count 169}` @`0xb8d8`, where `count` is the u32 word-count of the body, not an entry count. Body = a top header (`retries | wait<<8 | railCount<<16`), a rail directory of `railId<<16 | offset-from-body` u32s (cfg declaration order), then per rail `{blockCount<<16 | 1}` + command blocks. Each block starts with a packed header word checksummed so its bytes sum to `0 mod 256` (the header's low byte is the check byte): I²C `(0xC0|count)<<24 | ctrl<<4<<16 | slave<<8`, MMIO `(0x80|count)<<24`, PWM `0xC1<<24 | (ctrl<<4|0xD)<<16`. Then `block-delay`, a reserved `0`, then `count` `(reg/addr, mask, value)` commands (8-bit reg for I²C, 32-bit addr for MMIO). PWM blocks store `source-frq-hz`, `period-ns`, and a computed `duty-ns = ⌊(init-µV − min-µV) × period-ns / (max-µV − min-µV)⌋` — e.g. `(950000−600000)×2600/(1200000−600000) = 1516` = `0x5ec`, matching the golden.
- `brcommand`/bootrom fragment `[0xbb84, 0xbbc4)`: `{1.0, count 14}` @`0xbb84`. A different `aoblock` structure: an 8-word prefix, then per block a reg-size word, a checksummed I²C header (`slave | count<<8 | cksum<<16 | 0x80<<24`, cksum in byte 2 so header + commands sum to `0 mod 256`), then `(reg, value)` byte-packed command words (`f841da42` = reg `0x42`/val `0xda`, reg `0x41`/val `0xf8`). Two constants are only observed on this board: the prefix's `0x0b` and the 8/8-bit reg-size word `0x0909`.
- `misc` maps to the header `[0x4, 0xbb0)`, not a fragment. The `misc-si-l4t` scalars are placed by `tegrabct_v2`'s `s_Mb1BctFields` table — a `{name→id}` map (`Vars.6934`) joined to a `{id→(numInst, offset, size)}` map (`s_Mb1BctFields`), both dumpable from the unstripped ELF the same way as the SDRAM tables. Examples: `cpubl_carveout_addr` @`0xd4`, `aotag.boot_temp_threshold` @`0x3c`, `aocluster.evp_reset_addr` @`0x7d4`, `cpu.ccplex_platform_features` @`0x68`, `wdt.*` @`0x7ac`+. The whole region past the size field is byte-identical between the P2771 and P3636-P3509 goldens (only the `@0x0` size field differs), because the `misc` cfg is generic.

## SDRAM parameter `.cfg` (`src/bct/sdramCfg.ts`)

The board memory config (`t210_emc_reg_tool`/`t186_emc_reg_tool` output; `tegrabct --bct` input on T210, `tegrabct_v2 --sdram` on T186) is `SDRAM[<set>].<Field> = <value>;` lines listing every NvBootSdramParams field in struct declaration order, one little-endian u32 each — so `parseSdramCfg` packs a set as consecutive u32s in file order.

- T210 (`T210_SDRAM_CFG_LAYOUT`): 474 fields × 4 = `0x768`, exactly the BCT set stride; all four packed sets match the P3448 golden byte-for-byte.
- T186 (`T186_SDRAM_CFG_LAYOUT`): 1195 fields plus one reserved u32 the cfg generator never emits — named `BCT_NA` @`0x106c` (between `McBypassSidInit` and `McSidStreamidOverrideConfigPtcr`) in `tegrabct_v2`'s own field table — fill the `0x12b0` stride (`padWordsBefore`).
- Both layouts are verified two ways: byte-for-byte against the golden BCTs, and field-by-field against the tools' own `s_SdramTable` parse tables (`{name, offset, type, enumTable}` rows in the unstripped ELFs), extracted with `tools/extract-chip-tables.ts`. The table check is stronger — golden shift-diffing alone mislocated the T186 reserved word by two slots (invisible because the neighboring fields are zero on this board); the table pinned it.
- `NvBootMemoryType_*` token values come from `s_NvBootMemoryTypeTable` in the same binaries (identical tables): None=0, LpDdr2=1, Ddr3=2, LpDdr4=3, with the unsupported tokens (Ddr/Ddr2/LpDdr) collapsing to 0; unprefixed names are also accepted. Note this differs from the public-header enum order (LpDdr4 packs as 3, not 6) — confirmed by both goldens.
- Other values are hex (`0x…`) or decimal (`MemIoVoltage = 1100`) literals.
- The source cfgs are staged as `tests/golden/sdramcfg/{t210_p3448,t186_p2771}.cfg` by the regenerate scripts, alongside the BCTs the native tools compiled from them.
- The extracted field tables themselves are staged as `tests/golden/chiptables/{t210,t186,t264}_sdram.json` (`--fields-only` output; also carries the T21X_B01, T19x, and T23x tables the same binaries ship). `t264_sdram.json` comes from the R39.2.0 (JetPack 7.2) BSP's `tegrabct_v2`, which holds all four v2-generation tables at once — its T18x/T19x records are byte-identical to the R32-era ones, but T23x grew (`0x21f8` → `0x24d4`), so the T234 table must match the BSP line being flashed. `sdramCfgLayoutFromTable` turns a record into a name-addressed layout — the path for adding a chip without hand-deriving pads — and the tests assert it packs the golden cfgs byte-identically to the curated layouts.

## Signing (`tegrasign_v3_internal.py`, `src/sign.ts`)

- SBK / zero-key path: AES-128 CMAC with an all-zero key (`openssl dgst -mac cmac -macopt cipher:aes-128-cbc -macopt hexkey:00..00`). WebCrypto has no CMAC, so `aesCmac` builds it on AES-CBC (RFC 4493-validated); `sbkHash` is the zero-key case.
- PKC path: RSA-PSS, SHA-256 digest, salt length == digest length (`rsa_pss_saltlen:-1`), via `signRsaPss`. `NV_RSA_MAX_KEY_SIZE = 512` (up to RSA-4096).
- `sign_type`: `3` = RSA, `4` = ECC (`tegrabl_sigheader.h`; GSHV header is 400 bytes, magic `"GSHV"` @0 BE, `sign_type` @388 LE).
- The T210 `tegrasign` v1 binary doesn't expose the SBK path on its CLI (exits `4` / segfaults on a key file); the SBK reference is OpenSSL's CMAC directly.
- T186 SBK is validatable via `tegrasign_v2`, which does take a key (`--key <16 zero bytes> --list rcm_list.xml`): the CMAC it writes to `rcm_1.hash` over the RCM secure range `[0x520, end)` is byte-identical to `sbkHash(t186SecureRange(...))`. For a zero SBK the `*_encrypt.rcm` output equals the plaintext message (encryption skipped) and the hash lives in a separate file that `tegrarcm_v2` patches in at send time — so unfused devkits are flashed with the unsigned message.

## Regenerating golden fixtures

`tests/golden/*` is regenerated by scripts that run the real `tegraflash` tools (32-bit i386 Linux ELFs, statically linked — a `linux/386` docker container runs them without qemu) against a board's flash package. Each takes the package path as an argument; the packages come from the LineageOS device pages and are not vendored here.

```sh
# T210 — rcm_{0,1}.rcm + t210_p3448.bct, from the Jetson Nano (porg) package
tools/regenerate-t210.sh path/to/p3450_flash_package.tar.xz

# T186 — t186_{p2771,p3636-p3509}_{br,mb1}.bct, from the Jetson TX2 (quill) package
# (board auto-detected from the cfg filenames it ships)
tools/regenerate-t186.sh path/to/quill_flash_package.tar.xz

# T194 — t194_rcm_{0,1}.rcm, from any T18x/T19x L4T Driver Package (BSP)
tools/regenerate-t194.sh path/to/Jetson_Linux_R32.x_aarch64.tbz2

# T234/T264 — chiptables/t264_sdram.json, from a JetPack 7 (Thor-era) Jetson Linux BSP
tools/regenerate-t264.sh path/to/Jetson_Linux_R39.x_aarch64.tbz2

# T234/T264 — {t234,t264}_mb1_nvheader.bin, from the same JetPack 7 BSP
tools/regenerate-t234-mb1header.sh path/to/Jetson_Linux_R39.x_aarch64.tbz2
```

- `regenerate-t210.sh`: the unsigned download-and-execute RCM message for a 256-byte `0xAA` payload (`tegrarcm --listrcm`), then the finalized P3448 BCT (base `tegrabct` gen → `tegraparser` → `--updatedevparam` → `--updateblinfo`).
- `regenerate-t186.sh`: `tegrabct_v2 --brbct` and `--mb1bct` fed the package's six board `.cfg` fragments, plus `tegrarcm_v2 --listrcm` for the (board-independent) `t186_rcm_{0,1}.rcm` messages.
- `extract-mb1-scratch.ts <tegrabct_v2>`: emits `src/bct/v2/data/t186SdramScratch.ts` — the packed-SDRAM-scratch layout (`NvTegraT18xPackSdramParams`'s memtype prefix + 4 controller-map tables). The MB1-BCT header template `src/bct/v2/data/t186Mb1Header.ts` is the generic compiled `misc-si-l4t` header `[0, 0xbb0)`.
- `regenerate-t264.sh`: symtab extraction only (no docker) — dumps the BSP `tegrabct_v2`'s `s_SdramTable` parse tables for T18x/T19x/T23x/T264. No RCM goldens: R38+ `tegrarcm_v2` dropped `--listrcm` and only talks to live devices, so the T234/T264 RCM framings stay unmapped.
- `regenerate-t234-mb1header.sh`: `tegrahost_v2 --align` then `--addmb1nvheader` (chip `0x23` and `0x26`) wrapping synthetic payloads — see the MB1 NV header section above.

SBK reference over the T210 signed range, computed with OpenSSL's CMAC directly (tegrasign v1 doesn't expose the SBK path — see [Signing](#signing-tegrasign_v3_internalpy-srcsignts)):

```sh
python3 -c "b=open('t210_p3448.bct','rb').read(); open('sr.bin','wb').write(b[0x510:0x2800])"
openssl dgst -mac cmac -macopt cipher:aes-128-cbc -macopt hexkey:$(python3 -c "print('00'*16)") sr.bin
```

## Supported features

| feature                   | validated against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RCM message (T210)        | byte-identical to `tegrarcm --listrcm`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RCM message (T186)        | download message byte-identical to `tegrarcm_v2 --listrcm` (chip 0x18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RCM message (T194)        | byte-identical to `tegrarcm_v2 --listrcm` (chip 0x19) across 0/1/256-byte payloads, incl. both SHA-256 fields; `RcmFlasher` drives the applet hand-off (query = wire 7, download-and-execute = wire 5) — the flash-path opcodes (`ProgramBct`/`ProgramBootloader`) are still unknown and rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Applet load address       | full `NvTegraRcmGetAppletAddress` map from disassembly; T186/T194 cross-checked vs RCM golden `EntryAddress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| BCT (T210)                | header scalars, SDRAM stride, devType, signed section; bootloader table and `numSdramSets` (left 0) reproduced byte-for-byte vs the P3448 golden (`serializeBct`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BCT (T186)                | whole BR-BCT + MB1-BCT byte-exact vs `tegrabct_v2` (P2771 + P3636-P3509): MB1-BCT header, packed SDRAM boot-scratch, fragment directory, scr 2-bit `<m>` tail, and all 6 platform-config fragments; BR-BCT dev params + fixed init constants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SDRAM `.cfg`              | `parseSdramCfg` output byte-identical to the golden BCT SDRAM sets for T210 (P3448) and T186 (P3310/P2771); memory-type enum lifted from the tools' own parse tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| MB1 NV header (T234/T264) | `parseMb1NvHeader` matches real `tegrahost_v2 --addmb1nvheader` output across two chip ids, several payload sizes, and five `--magicid` cases (`MB1B`/`PSCB`/unrecognized/`TSEC` on T23x, `PSCB` on T264), cross-checked against `tegraflash_impl_t234.py`'s hardcoded offsets and the disassembled two-function pipeline (`NvTegraT23xFillMb1NvHeader` builds stage1 + the address table, `NvTegraHostAppendT23xHeader` builds stage0); every field offset independently reconfirmed against two real factory-signed production images (genuinely non-zero encrypted content). The stage1 `loadAddress`/`secondAddress` tables are fully decoded for both chips (`KNOWN_COMPONENT_MAGICS` / `T264_COMPONENT_MAGICS`) via a full docker magicid matrix. Known gap: those two fields plus the flag-bytes reflect only the tool's creation-time default and are overwritten later in a real signed image by an unidentified downstream step |
| Signing                   | SBK AES-CMAC vs RFC 4493 + OpenSSL; T186 RCM CMAC matches `tegrasign_v2` over `[0x520,·)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
