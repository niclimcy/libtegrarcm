/** NVIDIA USB vendor id. Recovery devices enumerate as 0955:xxxx across chips;
 * the bootrom only filters on the vendor id (product id varies per chip). */
export const VENDOR_NVIDIA = 0x0955

/** WebUSB filter: match any NVIDIA device, since the RCM product id is chip-specific. */
export const DeviceFilters: USBDeviceFilter[] = [{ vendorId: VENDOR_NVIDIA }]

/**
 * Known RCM/APX product ids per chip (tegraflash `APXPRODUCT` map). The WebUSB
 * filter only needs the vendor id, but these identify the connected chip. Orin
 * (0x7023) and Thor (0x7026) cross-checked against L4T R39.2.0's board targets;
 * the six t234 entries are board variants that all match under {@link APX_PID_MASK}.
 */
export const ApxProductId = {
  t210: [0x7721],
  t210nano: [0x7f21],
  t186: [0x7c18],
  t194: [0x7019],
  t194nx: [0x7e19],
  t234: [0x7023, 0x7223, 0x7323, 0x7423, 0x7523, 0x7623],
  thor: [0x7026]
} as const

/** APX recovery-device pid mask (`recovery_status` matches `pid & 0xF0FF`), so
 * board-variant middle nibbles don't change the match — e.g. every t234 pid
 * collapses to 0x7023. */
export const APX_PID_MASK = 0xf0ff

/** Tegra chip ids (the `--chip` argument, read from the bootrom UID). */
export const Chip = {
  T124: 0x40,
  T132: 0x13,
  T210: 0x21,
  T186: 0x18,
  T194: 0x19,
  T234: 0x23,
  /** "Thor" (T264) — L4T R39.2.0 / JetPack 7. */
  T264: 0x26
} as const
export type Chip = (typeof Chip)[keyof typeof Chip]

/** RCM message signing modes (tegrasign `signtype`). 0 = unsigned/zero-key. */
export const SignType = {
  None: 0,
  Sbk: 1,
  Zero: 2,
  Rsa: 3,
  Ecc: 4
} as const
export type SignType = (typeof SignType)[keyof typeof SignType]

/**
 * Bootrom applet load address by chip, decoded from the NvTegraRcmGetAppletAddress
 * jump table in tegrarcm/tegrarcm_v2:
 *   0x13 (T132) → 0x4000F000
 *   0x21 (T210) → 0x40010000  (also the default)
 *   0x18/0x19/0x23 (T186/T194/T234) → 0x40020000
 * This is the value tegrarcm substitutes for a zero load/entry — see PROTOCOL.md.
 */
export const APPLET_LOAD_ADDR_DEFAULT = 0x40010000
export const APPLET_LOAD_ADDR_T132 = 0x4000f000
/** v2 family (T186/T194/T234). */
export const APPLET_LOAD_ADDR_T186 = 0x40020000

export function appletLoadAddress(chip: Chip): number {
  switch (chip) {
    case Chip.T132:
      return APPLET_LOAD_ADDR_T132
    case Chip.T186:
    case Chip.T194:
    case Chip.T234:
    case Chip.T264:
      return APPLET_LOAD_ADDR_T186
    default:
      return APPLET_LOAD_ADDR_DEFAULT
  }
}

/** RCM message opcodes (NvBootRcmOpcode). */
export const RcmOpcode = {
  Sync: 0,
  ProgramBct: 1,
  ProgramBootloader: 2,
  DownloadExecute: 4,
  DownloadBct: 5,
  QueryBootRomVersion: 6
} as const
export type RcmOpcode = (typeof RcmOpcode)[keyof typeof RcmOpcode]

/** T194 wire opcodes differ from the T210/T186 enumeration: download-and-execute
 * is 5 (not 4) and the version query is 7 (as on T186). Only the two values
 * observed in the `--listrcm` goldens are captured; the program-bct/bootloader
 * wire values are unknown, so `t194WireOpcode` throws for them. */
export const T194RcmOpcode = {
  DownloadExecute: 5,
  QueryBootRomVersion: 7
} as const
export type T194RcmOpcode = (typeof T194RcmOpcode)[keyof typeof T194RcmOpcode]

export const T234RcmOpcode = {
  DownloadExecute: 5,
  QueryBootRomVersion: 7
} as const
export type T234RcmOpcode = (typeof T234RcmOpcode)[keyof typeof T234RcmOpcode]

export const T264RcmOpcode = {
  DownloadExecute: 5,
  QueryBootRomVersion: 7
} as const
export type T264RcmOpcode = (typeof T264RcmOpcode)[keyof typeof T264RcmOpcode]

/** RCM protocol version emitted by the message header, per chip family.
 * Encodes as `(chip << 16) | 1`: T186 → 0x00180001, T194 → 0x00190001,
 * T210 → 0x00210001. */
export const RcmVersion = {
  V1: 0x00000001,
  V186: 0x00180001,
  V194: 0x00190001,
  V210: 0x00210001,
  V234: 0x00230001,
  V264: 0x00260001
} as const

/** AES / hash block sizes used by RCM framing and CMAC. */
export const AES_BLOCK_SIZE = 16
export const RCM_RANDOM_AES_BLOCK_SIZE = 16

/** RSA-2048 modulus / signature size used by PKC-signed messages. */
export const RSA_2048_SIZE = 256

/** Signed-image header (tegrabl_sigheader.h): 400 bytes. The magic and sign_type
 * layout are chip-specific (from tegraflash_internal.py): T186 (0x18) uses magic
 * "GSHV" @0 (BE) with sign_type @388 (LE); T194/T234 use magic "NVDA"
 * (0x4e564441) and do not carry the T186 sign_type field. */
export const SIGHEADER_SIZE = 400
export const SIGHEADER_MAGIC_T186 = 'GSHV'
export const SIGHEADER_MAGIC_T194 = 'NVDA'
/** @deprecated T186-specific; use {@link SIGHEADER_MAGIC_T186}. */
export const SIGHEADER_MAGIC = SIGHEADER_MAGIC_T186
/** sign_type offset — T186 only. */
export const SIGHEADER_SIGNTYPE_OFFSET = 388

/** Message payloads are padded up to this alignment before signing/sending. */
export const RCM_MESSAGE_ALIGNMENT = 16
