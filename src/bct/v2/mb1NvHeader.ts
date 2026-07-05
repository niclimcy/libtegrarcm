import { BctError } from '../../errors'

/**
 * T234/T264 MB1 NV header — the fixed-size wrapper `tegrahost_v2
 * --addmb1nvheader` prepends to a boot component image before signing.
 * Unlike T186's BR-BCT/MB1-BCT (a single self-contained cfg-derived blob this
 * repo fully packs — see `mb1Bct.ts`), this is just the outer wrapper around
 * an arbitrary payload file; the SDRAM/board config for T234/T264 lives in a
 * separate structure this repo doesn't parse yet.
 *
 * Derived several ways, cross-checked against each other and against real
 * tool behavior (see tools/regenerate-t234-mb1header.sh, PROTOCOL.md):
 *
 * 1. `tegraflash_impl_t234.py` (plaintext Python shipped in the BSP) hardcodes
 *    the stage1 AES-GCM field offsets it patches post-hoc.
 * 2. `--addmb1nvheader` runs a *two-function* pipeline (confirmed by tracing
 *    the CLI dispatch in `main`, disassembling both functions, and a
 *    magicid-matrix run of the real tool under docker — see point 4):
 *      a. `main → NvTegraHostAddMb1NvHeaderCore → NvTegraT23xFillMb1NvHeader`
 *         (T264: `NvTegraT264FillMb1NvHeader`; chip-dispatched by
 *         `AddMb1NvHeaderCore`). `Fill` zero-fills a fresh
 *         `headerSize`-plus-payload buffer (`headerSize` a per-chip constant
 *         from a no-argument size call), writes `NVDA`, builds `stage1` from
 *         scratch (magic from `--magicid`, `payloadSize` from a caller length,
 *         `loadAddress`/`secondAddress`/flags from a per-name `strncmp` chain —
 *         see {@link KNOWN_COMPONENT_MAGICS}), SHA-512s the payload into
 *         `stage1 + 0x50`, and saves. It never touches `stage0`.
 *      b. `main → NvTegraHostAppendHeader → NvTegraHostAppendT23xHeader`
 *         (T264: `…AppendT264Header`; reached by a `jmp` tail-dispatch from the
 *         generic `AppendHeader`, which is why no direct `call` site exists).
 *         It reads the file `Fill` just wrote, leaves the already-present
 *         `stage1` in place, and builds `stage0` — either copying `stage1`'s
 *         fields for a ~12-name list or computing them generically otherwise
 *         (see {@link STAGE0_SHA512_OFFSET}) — plus the outer-header
 *         signature, and saves again.
 *    An earlier pass mis-attributed the whole thing to `AppendT23xHeader`
 *    alone; in fact `Fill` is the sole source of the stage1 address table, and
 *    `Append` only mirrors it into `stage0`. `AppendT23xHeader` does carry a
 *    literal `MBCT → 0x40040000` in its own (unreached) stage1-build path, but
 *    that path is dead in the CLI flow — `Fill` always runs first, so `Append`
 *    finds the header present and skips it; empirically `--magicid MBCT`
 *    yields `loadAddress=0`, flags `(0,0)`.
 * 3. The stage1 address mechanism is a plain `strncmp` if-else chain in
 *    `Fill` (PIC base `0x80dd530`), fully decoded and reproduced by the real
 *    tool for every name across both chip ids and several payload sizes — not
 *    a data-table lookup as an earlier pass hypothesized. Still treat
 *    {@link KNOWN_COMPONENT_MAGICS} as `tegrahost_v2`'s *creation-time*
 *    default, not ground truth for a real signed image (see its caveat).
 * 4. The two `NvTegraSaveFile` calls (one in `AddMb1NvHeaderCore`, one in
 *    `AppendT23xHeader`) writing the same output are what an `inotifywait`
 *    trace of a real run saw as "one file, written twice" — the two writes are
 *    the two pipeline stages, not two saves inside a single function.
 *    (`inotifywait` stands in for `strace`; `ptrace` is blocked in this
 *    sandbox even with `--privileged`/`--cap-add=SYS_PTRACE`.)
 * 5. Two real, factory-signed `mb1_{t234,t264}_prod.bin` images shipped in
 *    the R39.2.0 BSP (not committed here — proprietary NVIDIA firmware, used
 *    only for this investigation): both start with the same "NVDA" magic and
 *    have the same `stage0`/`stage1` offsets and field layout as our
 *    synthetic golden fixtures, with genuinely non-zero (real AES-GCM
 *    encrypted) derivation-string/IV/auth-tag fields, and `payloadSize`/
 *    `sha512Digest` matching their actual (much larger) payloads exactly.
 *    This is strong, independent confirmation of every offset in
 *    {@link COMPONENT_COMMON} and both `sha512Offset`s. It also *disproved* a
 *    same-session shortcut: both real images' `loadAddress`/`secondAddress`
 *    and the flag bytes at `0x10`-`0x11` differ from what `--addmb1nvheader`
 *    produces standalone — see the caveats below.
 */
export interface Mb1NvHeaderLayout {
  /** Total prefix size (a per-chip constant, not derived from the payload);
   * the wrapped payload begins here. */
  headerSize: number
  /** Byte offset of the top-level "NVDA" magic. */
  outerMagicOffset: number
  /** Offset of the stage0 component descriptor. Built from stage1 by an
   * explicit, field-by-field copy for ~12 recognized `--magicid` names, or
   * computed generically otherwise — see {@link STAGE0_SHA512_OFFSET} — and
   * not the same shape as stage1 past the common prefix either way. */
  stage0ComponentOffset: number
  /** Offset of the stage1 component descriptor (fully mapped). */
  stage1ComponentOffset: number
}

/**
 * The six magic ids `NvTegraT23xFillMb1NvHeader` (chip `0x23`) recognizes in
 * its `strncmp` chain, each with a hardcoded `loadAddress`/`secondAddress` set
 * at *creation* time. Fully decoded from the disassembly (PIC base
 * `0x80dd530`) and reproduced exactly by the real tool for every entry (docker
 * magicid matrix). Any *unrecognized* magic id leaves both addresses zero.
 * The flag bytes at `0x10`-`0x11` are `(1,1)` for all six of these recognized
 * names (including `BPMF`/`PFWP`, whose addresses are zero) and `(0,0)`
 * otherwise.
 *
 * `MBCT` is deliberately absent: although `AppendT23xHeader` carries a literal
 * `MBCT → 0x40040000`, that stage1-build path is dead in the CLI flow (see the
 * module doc's point 2), so a real `--magicid MBCT` run yields zero addresses.
 *
 * T264 (chip `0x26`) uses a *different* table — see {@link T264_COMPONENT_MAGICS};
 * notably `PSCB`'s `loadAddress` is `0x110000` there, not `0x120000`.
 *
 * Separately, `AppendT23xHeader` gates how it builds `stage0` on its own
 * ~12-name list (`MBCT`, `MB1B`, `MTSP`, `MTSM`, `WB0B`, `PSCB`, `BPMF`,
 * `PFWP`, `PSCR`, `TSEC`, `NDEC`, `XUSB`): copy `stage1`'s fields verbatim for
 * these, compute generically otherwise. That list is independent of this
 * address list — a name can be in one, the other, both, or neither — but since
 * `stage0` mirrors `stage1` either way for the fields this repo reads, it does
 * not change the parsed values.
 *
 * **Caveat that limits how useful this table is for a real signed image:**
 * two genuine factory-signed `mb1_{t234,t264}_prod.bin` production images
 * (R39.2.0 BSP) do *not* carry these hardcoded values — e.g. the real T264
 * image's `MB1B` component has `loadAddress=0x7fec0000`, not this table's
 * `0x50000000`, even though a synthetic `--addmb1nvheader` run on the same
 * tool reproduces `0x50000000` exactly. So something later in the real flash
 * pipeline overwrites `loadAddress`/`secondAddress` with genuine
 * board-specific values — this repo has not located that step. Treat this
 * table as documentation of `tegrahost_v2`'s own creation-time default, not
 * as ground truth for what a real signed image contains.
 */
export const KNOWN_COMPONENT_MAGICS: Readonly<
  Record<string, { loadAddress: number; secondAddress: number }>
> = {
  MB1B: { loadAddress: 0x50000000, secondAddress: 0x50000000 },
  PSCB: { loadAddress: 0x00120000, secondAddress: 0x00120400 },
  PSCR: { loadAddress: 0x00120000, secondAddress: 0x00120400 },
  WB0B: { loadAddress: 0x40040000, secondAddress: 0x40040000 },
  BPMF: { loadAddress: 0x0, secondAddress: 0x0 },
  PFWP: { loadAddress: 0x0, secondAddress: 0x0 }
} as const

/**
 * T264 (chip `0x26`) equivalent of {@link KNOWN_COMPONENT_MAGICS}, decoded
 * from `NvTegraT264FillMb1NvHeader`'s `strncmp` chain and confirmed by the
 * docker magicid matrix. As with the T23x table, every key is a recognized
 * name (flags `(1,1)`); the ten with zero addresses are recognized *only* for
 * that flag. Differences from the T23x table:
 *
 * - `PSCB`'s `loadAddress` is `0x110000` (T23x: `0x120000`); `secondAddress`
 *   is the same `0x120400`.
 * - No `PSCR` (unrecognized on T264 → zero addresses, flags `(0,0)`).
 * - Ten extra recognized names beyond the addressed three: `BPMF`, `PFWP`,
 *   `MINF`, `TSEC`, `GBFW`, `BIST`, `HPLD`, `HPFW`, `SBLD`, `SBFW` (13 total).
 *
 * Same real-image caveat as {@link KNOWN_COMPONENT_MAGICS}.
 */
export const T264_COMPONENT_MAGICS: Readonly<
  Record<string, { loadAddress: number; secondAddress: number }>
> = {
  MB1B: { loadAddress: 0x50000000, secondAddress: 0x50000000 },
  PSCB: { loadAddress: 0x00110000, secondAddress: 0x00120400 },
  WB0B: { loadAddress: 0x40040000, secondAddress: 0x40040000 },
  BPMF: { loadAddress: 0x0, secondAddress: 0x0 },
  PFWP: { loadAddress: 0x0, secondAddress: 0x0 },
  MINF: { loadAddress: 0x0, secondAddress: 0x0 },
  TSEC: { loadAddress: 0x0, secondAddress: 0x0 },
  GBFW: { loadAddress: 0x0, secondAddress: 0x0 },
  BIST: { loadAddress: 0x0, secondAddress: 0x0 },
  HPLD: { loadAddress: 0x0, secondAddress: 0x0 },
  HPFW: { loadAddress: 0x0, secondAddress: 0x0 },
  SBLD: { loadAddress: 0x0, secondAddress: 0x0 },
  SBFW: { loadAddress: 0x0, secondAddress: 0x0 }
} as const

/** Fields shared at the same relative offset by every component slot. */
const COMPONENT_COMMON = {
  magicOffset: 0x00,
  magicLength: 4,
  payloadSizeOffset: 0x04,
  loadAddressOffset: 0x08,
  /** A second, independently-set address — confirmed distinct from
   * `loadAddress` (not a duplicate): `--magicid PSCB` sets this to
   * `0x00120400` while `loadAddress` is `0x00120000`. Exact semantics (a
   * true "entry address", a second image region, ...) not determined. Also
   * subject to the real-image caveat on {@link KNOWN_COMPONENT_MAGICS}. */
  secondAddressOffset: 0x0c,
  /** Two bytes: `NvTegraHostAppendT23xHeader` unconditionally writes `(1, 1)`
   * here at creation time iff `--magicid` matched a known name, `(0, 0)`
   * otherwise (the unrecognized-name fallback path explicitly zeroes them).
   * But two real factory-signed production images show *different* values
   * here (`(1, 0x17)` and `(0, 0x25)`) for components whose magic clearly
   * *is* recognized (`MB1B`) — so some later, unlocated pipeline step
   * overwrites these bytes too, and they should not be read as a reliable
   * "recognized" indicator on a real signed image. Exposed as raw bytes
   * (`flagBytes`) rather than an interpreted boolean for this reason. */
  flagBytesOffset: 0x10,
  flagBytesLength: 2
} as const

/**
 * stage1's descriptor is fully mapped past the common prefix (matches
 * `tegraflash_impl_t234.py`'s hardcoded offsets exactly, and was confirmed
 * against two real signed production images with genuinely non-zero
 * encrypted contents): a 16-byte AES-GCM derivation string @0x20, a 12-byte
 * IV @0x34, a 16-byte auth tag @0x40, then the SHA-512 digest @0x50..0x90.
 */
const STAGE1_SHA512_OFFSET = 0x50
const STAGE1_SHA512_LENGTH = 64

/**
 * stage0's descriptor is NOT the same shape past the common prefix: bytes
 * [0x14, 0x20) hold a second copy of payloadSize (absent/zero in stage1's
 * equivalent range), and its SHA-512 digest lands 16 bytes later than
 * stage1's, at @0x60 rather than @0x50. The bytes between the size copy and
 * the digest are unmapped.
 *
 * For a `--magicid` in `AppendT23xHeader`'s own ~12-name copy list (see
 * {@link KNOWN_COMPONENT_MAGICS}, "Separately, …"), `NvTegraHostAppendT23xHeader`
 * builds stage0 by an explicit, field-by-field copy from the stage1 that
 * `Fill` already wrote: magic, `payloadSize` (written to *both* `0x04` and
 * `0x20` — the source of the "second copy" above), the flag bytes plus two
 * further bytes at `0x12`-`0x13` (previously assumed reserved), `loadAddress`,
 * and `secondAddress`.
 *
 * For an unrecognized name, a different, generic path computes stage0
 * instead: `payloadSize` is written directly (not copied from stage1) at an
 * offset selected by `index * 0xa0` where `index` (0 or 1) comes from
 * absolute file offset `0xfe0`; magic is either the raw `--magicid` bytes or
 * an `sprintf`-generated name depending on a further internal check; the flag
 * bytes are explicitly zeroed; and one extra byte is the sum of two
 * parameters. Confirmed empirically with an unrecognized `XXXX` magic id and
 * with `TSEC` (recognized by *this* copy-vs-generic gate but not by the
 * separate loadAddress table, letting both mechanisms be tested
 * independently — see `mb1NvHeader.test.ts`).
 */
const STAGE0_SHA512_OFFSET = 0x60
const STAGE0_SHA512_LENGTH = 64

/** stage0's second copy of `payloadSize` (the `0x20` copy the copy-path writes
 * in addition to `0x04`); absent from stage1. */
const STAGE0_PAYLOAD_SIZE_COPY_OFFSET = 0x20

/**
 * Deterministic outer-header fields for the *unsigned* build path
 * (`--addmb1nvheader … nvidia-rsa`, which leaves the AES-GCM
 * der_str/IV/auth-tag zero). All within the `0x2000` header and shared by chip
 * `0x23`/`0x26`. The two SHA-512s cover header ranges only — the payload's
 * integrity is carried by the per-component digests instead.
 */
const OUTER_HEADER = {
  /** SHA-512 of `[headerHashFrom, headerSize)` — written *last*, since its
   * range covers {@link OUTER_HEADER.innerHashOffset}. */
  headerHashOffset: 0x04,
  headerHashFrom: 0x44,
  /** SHA-512 of `[innerHashFrom, headerSize)` — written *first*. */
  innerHashOffset: 0x50,
  innerHashFrom: 0xfc0,
  /** u32 `1`: the component index the generic stage0 path reads at `0xfe0`. */
  indexOffset: 0xfe0,
  /** u32 `1` the fill step writes between stage0 and stage1. */
  interStageOffset: 0x1aa0
} as const

/** T234 (chip 0x23) and T264 (chip 0x26) share this file-level layout —
 * verified identical (header size, stage0/stage1 offsets, field offsets
 * within each component) against both chip ids via `tegrahost_v2
 * --addmb1nvheader`, and independently against two real signed production
 * images. Only the `--magicid` dispatch inside the fill step differs
 * per-chip — see {@link KNOWN_COMPONENT_MAGICS}. */
export const T234_MB1_NV_HEADER_LAYOUT: Mb1NvHeaderLayout = {
  headerSize: 0x2000,
  outerMagicOffset: 0x0,
  stage0ComponentOffset: 0x1400,
  stage1ComponentOffset: 0x1ee0
} as const

const OUTER_MAGIC = 'NVDA'

export interface Mb1NvHeaderComponent {
  /** The `--magicid` string this component was built with (e.g. `MB1B`). */
  magic: string
  payloadSize: number
  loadAddress: number
  /** See {@link COMPONENT_COMMON}'s `secondAddressOffset`. */
  secondAddress: number
  /** Raw bytes at `0x10`-`0x11` — see {@link COMPONENT_COMMON}'s
   * `flagBytesOffset` for why this isn't exposed as an interpreted flag. */
  flagBytes: Uint8Array
  /** SHA-512 digest of the wrapped payload. */
  sha512Digest: Uint8Array
}

export interface Mb1NvHeader {
  stage0: Mb1NvHeaderComponent
  stage1: Mb1NvHeaderComponent
  /** The wrapped image: everything past the fixed-size header. */
  payload: Uint8Array
}

function readComponent(
  buf: Uint8Array,
  view: DataView,
  base: number,
  sha512Offset: number,
  sha512Length: number
): Mb1NvHeaderComponent {
  const magicBytes = buf.subarray(
    base + COMPONENT_COMMON.magicOffset,
    base + COMPONENT_COMMON.magicOffset + COMPONENT_COMMON.magicLength
  )
  return {
    magic: new TextDecoder('latin1').decode(magicBytes),
    payloadSize: view.getUint32(base + COMPONENT_COMMON.payloadSizeOffset, true),
    loadAddress: view.getUint32(base + COMPONENT_COMMON.loadAddressOffset, true),
    secondAddress: view.getUint32(base + COMPONENT_COMMON.secondAddressOffset, true),
    flagBytes: buf.slice(
      base + COMPONENT_COMMON.flagBytesOffset,
      base + COMPONENT_COMMON.flagBytesOffset + COMPONENT_COMMON.flagBytesLength
    ),
    sha512Digest: buf.slice(base + sha512Offset, base + sha512Offset + sha512Length)
  }
}

/**
 * Parse a `tegrahost_v2 --addmb1nvheader`-produced file into its two
 * component descriptors and the wrapped payload.
 */
export function parseMb1NvHeader(
  file: Uint8Array<ArrayBuffer>,
  layout: Mb1NvHeaderLayout = T234_MB1_NV_HEADER_LAYOUT
): Mb1NvHeader {
  if (file.length < layout.headerSize) {
    throw new BctError(`MB1 NV header file is shorter than the ${layout.headerSize}-byte header`)
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const magicBytes = file.subarray(layout.outerMagicOffset, layout.outerMagicOffset + 4)
  const outerMagic = new TextDecoder('latin1').decode(magicBytes)
  if (outerMagic !== OUTER_MAGIC) {
    throw new BctError(`expected outer magic "${OUTER_MAGIC}", got "${outerMagic}"`)
  }
  return {
    stage0: readComponent(
      file,
      view,
      layout.stage0ComponentOffset,
      STAGE0_SHA512_OFFSET,
      STAGE0_SHA512_LENGTH
    ),
    stage1: readComponent(
      file,
      view,
      layout.stage1ComponentOffset,
      STAGE1_SHA512_OFFSET,
      STAGE1_SHA512_LENGTH
    ),
    payload: file.subarray(layout.headerSize)
  }
}

async function sha512(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', data))
}

function writeMagic(buf: Uint8Array, offset: number, magic: string): void {
  for (let i = 0; i < COMPONENT_COMMON.magicLength; i++) {
    buf[offset + i] = i < magic.length ? magic.charCodeAt(i) & 0xff : 0
  }
}

/** Chip id whose address table is {@link T264_COMPONENT_MAGICS}. */
const CHIP_T264 = 0x26

export interface SerializeMb1NvHeaderOptions {
  /** Component magic id (`--magicid`), 1-4 chars (e.g. `MB1B`). */
  magic: string
  /** `0x23` (T234, default) or `0x26` (T264) — picks the default address
   * table when {@link SerializeMb1NvHeaderOptions.magics} isn't given. */
  chip?: number
  /** Override the name→address table (defaults to the per-chip table). A magic
   * present here is "recognized": it gets these addresses and flag bytes
   * `(1,1)`; any other magic gets zero addresses and flags `(0,0)`. */
  magics?: Readonly<Record<string, { loadAddress: number; secondAddress: number }>>
  /** File layout (defaults to {@link T234_MB1_NV_HEADER_LAYOUT}). */
  layout?: Mb1NvHeaderLayout
}

/**
 * Build the MB1 NV header wrapper for `payload` — the pure-TS equivalent of
 * `tegrahost_v2 --addmb1nvheader <file> nvidia-rsa`, needing no NVIDIA binary.
 * Produces byte-identical output to the real tool on the *unsigned* dev path
 * (AES-GCM der_str/IV/auth-tag left zero); for a PKC/SBK-fused part the
 * board's OEM key would additionally be needed, exactly as the real flow
 * splits header-build from signing.
 *
 * Reproduces both descriptors and the two outer SHA-512s exactly as the
 * decoded `NvTegraT23xFillMb1NvHeader` (stage1 + addresses) and
 * `NvTegraHostAppendT23xHeader` (stage0) pipeline does — see the module doc.
 * Round-trips through {@link parseMb1NvHeader}.
 */
export async function serializeMb1NvHeader(
  payload: Uint8Array,
  options: SerializeMb1NvHeaderOptions
): Promise<Uint8Array<ArrayBuffer>> {
  const layout = options.layout ?? T234_MB1_NV_HEADER_LAYOUT
  const magics =
    options.magics ?? (options.chip === CHIP_T264 ? T264_COMPONENT_MAGICS : KNOWN_COMPONENT_MAGICS)
  const { magic } = options
  if (magic.length < 1 || magic.length > COMPONENT_COMMON.magicLength) {
    throw new BctError(
      `MB1 NV header magic must be 1-${COMPONENT_COMMON.magicLength} chars, got "${magic}"`
    )
  }

  const buf = new Uint8Array(layout.headerSize + payload.length)
  const view = new DataView(buf.buffer)
  buf.set(payload, layout.headerSize)
  writeMagic(buf, layout.outerMagicOffset, OUTER_MAGIC)

  const entry = Object.prototype.hasOwnProperty.call(magics, magic) ? magics[magic] : undefined
  const loadAddress = entry?.loadAddress ?? 0
  const secondAddress = entry?.secondAddress ?? 0
  const flag = entry ? 1 : 0
  // Hash the payload from its final in-buffer location (ArrayBuffer-backed).
  const digest = await sha512(buf.subarray(layout.headerSize))

  const writeCommon = (base: number): void => {
    writeMagic(buf, base + COMPONENT_COMMON.magicOffset, magic)
    view.setUint32(base + COMPONENT_COMMON.payloadSizeOffset, payload.length, true)
    view.setUint32(base + COMPONENT_COMMON.loadAddressOffset, loadAddress, true)
    view.setUint32(base + COMPONENT_COMMON.secondAddressOffset, secondAddress, true)
    buf[base + COMPONENT_COMMON.flagBytesOffset] = flag
    buf[base + COMPONENT_COMMON.flagBytesOffset + 1] = flag
  }

  writeCommon(layout.stage1ComponentOffset)
  buf.set(digest, layout.stage1ComponentOffset + STAGE1_SHA512_OFFSET)

  writeCommon(layout.stage0ComponentOffset)
  view.setUint32(
    layout.stage0ComponentOffset + STAGE0_PAYLOAD_SIZE_COPY_OFFSET,
    payload.length,
    true
  )
  buf.set(digest, layout.stage0ComponentOffset + STAGE0_SHA512_OFFSET)

  view.setUint32(OUTER_HEADER.indexOffset, 1, true)
  view.setUint32(OUTER_HEADER.interStageOffset, 1, true)

  // Inner hash first — the header hash's range covers it.
  buf.set(
    await sha512(buf.subarray(OUTER_HEADER.innerHashFrom, layout.headerSize)),
    OUTER_HEADER.innerHashOffset
  )
  buf.set(
    await sha512(buf.subarray(OUTER_HEADER.headerHashFrom, layout.headerSize)),
    OUTER_HEADER.headerHashOffset
  )

  return buf
}
