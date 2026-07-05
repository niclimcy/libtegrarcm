import { parseSdramCfg, T186_SDRAM_CFG_LAYOUT } from './bct/sdramCfg'
import { BootMedium, serializeBct, signBct, type BctLayout, type BootLoaderInfo } from './bct/v1'
import { assembleBrBct, parseT186DevParams } from './bct/v2/brBct'
import { packBrCommandFragment, parseBrCommandCfg } from './bct/v2/brCommand'
import { T186_MB1_HEADER } from './bct/v2/data/t186Mb1Header'
import { T186_SDRAM_SCRATCH } from './bct/v2/data/t186SdramScratch'
import {
  assembleMb1Bct,
  packMb1Fragment,
  packScrFragment,
  parseRegisterPairs,
  parseRegisterTriples,
  parseScrFragment
} from './bct/v2/mb1Bct'
import { packPmicFragment, parsePmicCfg } from './bct/v2/pmic'
import type { SdramScratchLayout } from './bct/v2/sdramScratch'
import { chipProfile } from './chips'
import { appletLoadAddress, Chip } from './constants'
import { BctError } from './errors'
import type { TegraBootPackage } from './flash'

/**
 * Turn a board flash package (`*_flash_package.txz`, untarred) into the signed
 * BCT + boot images + recovery applet the RCM flow needs — the in-library
 * equivalent of `tegraparser` + `tegrabct` + `tegrasign`, so a package can be
 * flashed with no NVIDIA host tool. The `.txz` must be decompressed by the
 * caller (xz is environment-specific); pass the resulting tar bytes to
 * {@link parseFlashPackageTar}.
 *
 * The v1 BCT family (T124/T132/T210 — one flat `NvBoot` BCT, `bct/v1.ts`) is
 * assembled end-to-end by {@link buildV1BootPackage}; the chip-specific bits
 * (boot-data version, applet load address, SDRAM layout) are derived from the
 * chip, defaulting to T210. The T210 BCT it produces is byte-identical to
 * `tegrabct`/`tegrasign` output (validated against the real p3448 golden — see
 * `tests/flashPackage.test.ts`).
 *
 * T186 (v2) splits boot config into a BR-BCT + MB1-BCT (`bct/v2/`) and is
 * assembled by {@link buildV2BootPackage} from the package's cfg set (surfaced
 * by {@link parseV2CfgSet}). Both BCTs reproduce `tegrabct_v2` byte-for-byte.
 */

/** Chips this library can drive over RCM: v1 BCT family, T186 (v2), and the
 * T194 applet hand-off. T234/T264 have no host-buildable RCM framing. */
const RCM_FLASHABLE_CHIPS: ReadonlySet<number> = new Set([
  Chip.T124,
  Chip.T132,
  Chip.T210,
  Chip.T186,
  Chip.T194
])

function isRcmFlashable(chip: number): chip is Chip {
  return RCM_FLASHABLE_CHIPS.has(chip)
}

export interface FlashPackage {
  /** Chip the package targets, from `flash.sh`'s `--chip`. */
  chip: Chip
  files: Map<string, Uint8Array>
  /** RCM applet `flash.sh` downloads-and-executes (its `--applet` argument). */
  applet: string
  /** `--odmdata` from `flash.sh`, when it's a literal (v2 computes it in shell). */
  odmData?: number
  /** Candidate SDRAM `.cfg`s (v1 — flash.sh picks per module SKU). */
  sdramCfgs: string[]
  /** Candidate partition-layout `.xml`s (v1). */
  layouts: string[]
}

const decoder = new TextDecoder()

function text(files: Map<string, Uint8Array>, name: string): string {
  const data = files.get(name)
  if (!data) throw new Error(`${name} missing from flash package`)
  return decoder.decode(data)
}

const TAR_BLOCK = 512

function tarString(bytes: Uint8Array, offset: number, length: number): string {
  const end = bytes.indexOf(0, offset)
  return decoder.decode(
    bytes.subarray(offset, end === -1 || end > offset + length ? offset + length : end)
  )
}

/** Minimal ustar reader — regular files only, enough for a flash package. */
export function untar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (let offset = 0; offset + TAR_BLOCK <= bytes.length;) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK)
    if (header.every((b) => b === 0)) break // end-of-archive
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const size = Number.parseInt(tarString(header, 124, 12), 8) || 0
    const typeflag = header[156]
    offset += TAR_BLOCK
    // regular files only ('0' or NUL)
    if (typeflag === 0x30 || typeflag === 0) {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return files
}

/**
 * Parse an untarred flash package: read `flash.sh` for the chip/applet/odmdata
 * and enumerate the candidate SDRAM `.cfg`s and partition-layout `.xml`s.
 */
export function parseFlashPackageTar(tar: Uint8Array): FlashPackage {
  const files = untar(tar)

  const flashSh = text(files, 'flash.sh')
  const chipId = /--chip\s+(0x[0-9a-fA-F]+)/.exec(flashSh)?.[1]
  const applet = /--applet\s+(\S+)/.exec(flashSh)?.[1]
  if (!chipId || !applet)
    throw new Error('flash.sh has no --chip/--applet; not a Jetson flash package?')
  const chip = Number.parseInt(chipId, 16)
  if (!isRcmFlashable(chip)) {
    // T234/T264 (0x23/0x26) have no host-buildable RCM framing (see PROTOCOL.md)
    throw new Error(`chip ${chipId} has no RCM flash flow in this library`)
  }
  if (!files.has(applet)) throw new Error(`applet ${applet} missing from flash package`)

  const odmData = /--odmdata\s+(0x[0-9a-fA-F]+)/.exec(flashSh)?.[1]
  const names = [...files.keys()]
  const sdramCfgs = names.filter(
    (n) => /^[^/]+\.cfg$/.test(n) && text(files, n).includes('SDRAM[0].')
  )
  // flash.sh's BCT_CFG default goes first
  const defaultCfg = /BCT_CFG="([^"]+)"/.exec(flashSh)?.[1]
  if (defaultCfg) sdramCfgs.sort((a, b) => Number(b === defaultCfg) - Number(a === defaultCfg))
  return {
    chip,
    files,
    applet,
    ...(odmData !== undefined && { odmData: Number.parseInt(odmData, 16) }),
    sdramCfgs,
    layouts: names.filter((n) => /^flash_.*\.xml$/.test(n))
  }
}

/**
 * The MB1/BR-BCT cfg set, from `flash.sh`'s `--*_config` / `--dev_params`
 * flags. Each value is a package filename; the MB1-BCT uses the cold-boot scr
 * (`--scr_cold_boot_config`), not the recovery `--scr_config`. These are the
 * standard `tegraflash_v2` flags shared across the v2 chip family (T18x/T19x/
 * T23x); {@link buildV2BootPackage} currently assembles T186 from them. See
 * PROTOCOL.md.
 */
export interface V2CfgSet {
  sdram: string
  misc: string
  pinmux: string
  pmic: string
  pmc: string
  prod: string
  scrColdBoot: string
  brCommand: string
  devParams: string
}

const V2_CFG_FLAGS: Record<keyof V2CfgSet, string> = {
  sdram: 'sdram_config',
  misc: 'misc_config',
  pinmux: 'pinmux_config',
  pmic: 'pmic_config',
  pmc: 'pmc_config',
  prod: 'prod_config',
  scrColdBoot: 'scr_cold_boot_config',
  brCommand: 'br_cmd_config',
  devParams: 'dev_params'
}

/**
 * Resolve a `flash.sh` config value to a package file, substituting a single
 * `${VAR}` (e.g. the version-dependent `${PMIC_CFG_VER}`) by trying each
 * candidate file present. Returns the resolved name.
 */
function resolvePackageFile(value: string, files: Map<string, Uint8Array>): string | undefined {
  if (files.has(value)) return value
  if (!value.includes('${')) return undefined
  // escape each literal piece, then join the `${VAR}` gaps with a wildcard
  const escaped = value
    .split(/\$\{[^}]+\}/g)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp('^' + escaped.join('(.+)') + '$')
  // deterministic: earliest matching name (c03 sorts before c04)
  return [...files.keys()].filter((n) => pattern.test(n)).sort()[0]
}

/**
 * Surface the v2 cfg set from an untarred package's `flash.sh`. Only the
 * `flash` command's `FLASH_CMD_FLASH` block is read (the cold-boot BCT path).
 */
export function parseV2CfgSet(flashSh: string, files: Map<string, Uint8Array>): V2CfgSet {
  const cfgs = {} as V2CfgSet
  for (const [key, flag] of Object.entries(V2_CFG_FLAGS) as [keyof V2CfgSet, string][]) {
    const raw = new RegExp(`--${flag}\\s+(\\S+)`).exec(flashSh)?.[1]
    if (!raw) throw new BctError(`flash.sh has no --${flag}`)
    const resolved = resolvePackageFile(raw, files)
    if (!resolved) throw new BctError(`--${flag} file ${raw} not found in package`)
    cfgs[key] = resolved
  }
  return cfgs
}

/**
 * Evaluate `flash.sh`'s `ODMDATA=$(( ... ))` bit expression — a `|`-OR of
 * `1<<N` terms (and the conditional lock bit is *not* included; that path is
 * only taken with `--lock`). Returns the base odmData the package flashes with.
 */
export function parseV2OdmData(flashSh: string): number {
  const expr = /ODMDATA=\$\(\(([^)]*)\)\)/.exec(flashSh)?.[1]
  if (!expr) return 0
  let value = 0
  for (const term of expr.split('|')) {
    const shift = /^\s*1\s*<<\s*(\d+)\s*$/.exec(term)
    if (!shift?.[1]) throw new BctError(`unsupported ODMDATA term: ${term.trim()}`)
    value |= 1 << Number(shift[1])
  }
  return value >>> 0
}

/**
 * The boot images `flash.sh` streams after the BCTs, from its `--bl` bootloader
 * plus the `--bins "<name> <file>; …"` list, in declaration order. Names are
 * dropped; the caller streams the files. Filenames may carry a `${VAR}` (e.g.
 * the version-dependent bpmp dtb), resolved against the package like the cfg
 * set; a referenced file that isn't present is an error, not a silent skip.
 */
export function parseV2Bins(flashSh: string, files: Map<string, Uint8Array>): string[] {
  const refs: string[] = []
  const bl = /--bl\s+(\S+)/.exec(flashSh)?.[1]
  if (bl) refs.push(bl)
  const bins = /--bins\s+"([^"]*)"/.exec(flashSh)?.[1]
  if (bins) {
    for (const entry of bins.split(';')) {
      const file = entry.trim().split(/\s+/)[1]
      if (file) refs.push(file)
    }
  }
  const images: string[] = []
  for (const ref of refs) {
    const resolved = resolvePackageFile(ref, files)
    if (!resolved) throw new BctError(`boot image ${ref} not found in package`)
    if (!images.includes(resolved)) images.push(resolved)
  }
  return images
}

// tegraparser defaults per boot medium (no XML knobs feed these)
const V1_MEDIA = {
  sdmmc: { medium: BootMedium.Sdmmc, blockSizeLog2: 14, pageSizeLog2: 9, devParams: [0x9, 0x2] },
  spi: { medium: BootMedium.SpiFlash, blockSizeLog2: 15, pageSizeLog2: 11, devParams: [0x0, 0x4] }
} as const

const V1_PARTITION_SIZE = 0x1000000 // constant in tegrabct output for both media
// signed-range words serializeBct doesn't cover (see PROTOCOL.md header scalars)
const V1_NUM_PARAM_SETS_OFFSET = 0x540

export interface V1Layout {
  media: (typeof V1_MEDIA)[keyof typeof V1_MEDIA]
  bootLoaders: BootLoaderInfo[]
  /** distinct image files the bootloader-table entries reference, in order */
  bootImages: string[]
}

/**
 * BCT boot-device/bootloader-table inputs from a partition-layout (.xml or .cfg).
 * Partitions allocate sequentially; the table lists its bootloader/NVC partitions.
 * `attribute` is the 1-based partition id on SPI, 0 on sdmmc.
 * `loadAddress` is the chip's applet load address (see {@link appletLoadAddress}).
 */
export function parseV1Layout(
  layoutText: string,
  files: Map<string, Uint8Array>,
  loadAddress: number = appletLoadAddress(Chip.T210)
): V1Layout {
  const isXml = layoutText.includes('<partition_layout>') || layoutText.includes('<device')
  if (isXml) {
    const device = /<device[^>]*type="(\w+)"[^>]*>([\s\S]*?)(?=<device|<\/partition_layout)/.exec(
      layoutText
    )
    const deviceType = device?.[1]
    const deviceBody = device?.[2]
    if (deviceBody === undefined) throw new Error('no <device> in partition layout')
    const type = deviceType === 'sdmmc' ? 'sdmmc' : deviceType === 'spi' ? 'spi' : null
    if (!type) throw new Error(`unsupported boot device type "${deviceType}"`)
    const media = V1_MEDIA[type]

    const bootLoaders: BootLoaderInfo[] = []
    const bootImages: string[] = []
    let offset = 0
    let id = 0
    const partition = /<partition\s+name="([^"]+)"[^>]*type="([^"]+)"[^>]*>([\s\S]*?)<\/partition>/g
    for (const match of deviceBody.matchAll(partition)) {
      const name = match[1]!
      const partType = match[2]!
      const body = match[3]!
      id += 1
      const size = Number.parseInt(/<size>\s*(\d+)\s*<\/size>/.exec(body)?.[1] ?? '', 10)
      if (Number.isNaN(size)) throw new Error(`partition ${name} has no size`)
      if (partType === 'bootloader' && /^NVC/.test(name)) {
        let filename = /<filename>\s*(\S+)\s*<\/filename>/.exec(body)?.[1]
        if (filename === undefined) {
          throw new Error(`bootloader image for ${name} missing from package`)
        }
        let image = files.get(filename)
        if (!image) {
          for (const [fName, fBytes] of files) {
            if (fName.toLowerCase() === filename.toLowerCase()) {
              filename = fName
              image = fBytes
              break
            }
          }
        }
        if (!image && files.size === 1) {
          const firstKey = [...files.keys()][0]
          if (firstKey !== undefined) {
            filename = firstKey
            image = files.get(firstKey)
          }
        }
        if (!image) {
          throw new Error(`bootloader image for ${name} missing from package`)
        }
        bootLoaders.push({
          version: 1,
          startBlock: offset >>> media.blockSizeLog2,
          startPage: 0,
          length: image.length,
          loadAddress,
          entryPoint: loadAddress,
          attribute: type === 'spi' ? id : 0
        })
        if (!bootImages.includes(filename)) bootImages.push(filename)
      }
      offset += size
    }
    if (!bootLoaders.length) throw new Error('no NVC bootloader partition in layout')
    return { media, bootLoaders, bootImages }
  } else {
    let type: 'sdmmc' | 'spi' = 'sdmmc'
    const blockMatch = /BlockSize\s*=\s*(\d+)/i.exec(layoutText)
    if (blockMatch && blockMatch[1] !== undefined) {
      const bs = parseInt(blockMatch[1], 10)
      if (bs === 32768 || bs === 65536) {
        type = 'spi'
      }
    }
    const media = V1_MEDIA[type]

    const bootLoaders: BootLoaderInfo[] = []
    const bootImages: string[] = []

    const sections = layoutText.split(/^[ \t]*\[partition\][ \t]*$/im)
    let offset = 0
    let id = 0
    for (const section of sections.slice(1)) {
      let name = ''
      let partType = ''
      let size = 0
      let fileToFlash: string | undefined = undefined

      for (const line of section.split(/\r?\n/)) {
        const cleanLine = line.trim()
        if (!cleanLine || cleanLine.startsWith('#')) continue
        const parts = cleanLine.split('=')
        if (parts.length < 2) continue
        const key = parts[0]!.trim().toLowerCase()
        const value = parts.slice(1).join('=').trim()

        if (key === 'name') name = value
        else if (key === 'type') partType = value.toLowerCase()
        else if (key === 'size') size = parseInt(value, 10) || 0
        else if (key === 'file_to_flash' || key === 'filename') fileToFlash = value
      }

      if (name) {
        id += 1
        if (partType === 'bootloader' || name.startsWith('NVC') || name === 'EBT') {
          const key = fileToFlash
          let filename: string | undefined = undefined
          let image: Uint8Array | undefined = undefined

          if (key !== undefined) {
            image = files.get(key)
            if (image) {
              filename = key
            } else {
              for (const [fName, fBytes] of files) {
                if (fName.toLowerCase() === key.toLowerCase()) {
                  filename = fName
                  image = fBytes
                  break
                }
              }
            }
          }

          if (!image && files.size === 1) {
            const firstKey = [...files.keys()][0]
            if (firstKey !== undefined) {
              filename = firstKey
              image = files.get(firstKey)
            }
          }

          if (filename && image) {
            bootLoaders.push({
              version: 1,
              startBlock: offset >>> media.blockSizeLog2,
              startPage: 0,
              length: image.length,
              loadAddress,
              entryPoint: loadAddress,
              attribute: type === 'spi' ? id : 0
            })
            if (!bootImages.includes(filename)) bootImages.push(filename)
          } else {
            throw new Error(`bootloader image for ${name} missing from package`)
          }
        }
        offset += size
      }
    }
    if (!bootLoaders.length) throw new Error('no bootloader partition in layout config')
    return { media, bootLoaders, bootImages }
  }
}
/**
 * Signed BCT + boot images + recovery applet for the RCM flash flow, for a v1
 * BCT chip (T124/T132/T210, default T210). The boot-data version, applet load
 * address, and SDRAM layout are derived from `chip`; the flat v1 BCT layout is
 * shared across the family. Only T210 has a v1 SDRAM layout in the registry, so
 * other v1 chips need one supplied on their chip profile.
 */
export async function buildV1BootPackage(
  pkg: FlashPackage,
  sdramCfg: string,
  layoutXml: string,
  chip: Chip = Chip.T210
): Promise<TegraBootPackage> {
  const profile = chipProfile(chip)
  const sdramLayout = profile.sdramCfg
  if (!sdramLayout) {
    throw new BctError(`chip 0x${chip.toString(16)} has no v1 SDRAM layout in its chip profile`)
  }
  const loadAddress = appletLoadAddress(chip)
  const { media, bootLoaders, bootImages } = parseV1Layout(
    text(pkg.files, layoutXml),
    pkg.files,
    loadAddress
  )
  const devParams = new Uint8Array(media.devParams.length * 4)
  media.devParams.forEach((word, i) => new DataView(devParams.buffer).setUint32(i * 4, word, true))

  const serializeOptions: { template?: Uint8Array; layout?: BctLayout } = {}
  if (profile.bct !== undefined) {
    serializeOptions.layout = profile.bct
  }

  const layout = profile.bct
  const bct = serializeBct(
    {
      // v1 boot-data version embeds the chip id: e.g. T210 (0x21) → 0x00210001.
      bootDataVersion: (chip << 16) | 0x0001,
      blockSizeLog2: media.blockSizeLog2,
      pageSizeLog2: media.pageSizeLog2,
      // partitionSize is chip-specific: T210 = 16 MB, T124 = 128 MB
      partitionSize: layout?.partitionSize ?? V1_PARTITION_SIZE,
      ...(pkg.odmData !== undefined && { odmData: pkg.odmData }),
      bootDevice: { medium: media.medium, raw: devParams },
      sdram: parseSdramCfg(text(pkg.files, sdramCfg), sdramLayout).map((raw) => ({ raw })),
      bootLoaders
    },
    serializeOptions
  )
  const view = new DataView(bct.buffer)
  const numParamSetsOffset = layout?.numParamSetsOffset ?? V1_NUM_PARAM_SETS_OFFSET
  view.setUint32(numParamSetsOffset, 1, true)
  const reservedPadOffset = layout?.reservedPadOffset ?? (profile.bct?.size ?? 0x2800) - 20
  view.setUint8(reservedPadOffset, 0x80)
  await signBct(bct, profile.bct) // zero-key (SBK); PKC-fused devices need the RSA-PSS path

  return {
    bct,
    bootImages: bootImages.map((name) => pkg.files.get(name)!),
    executePayload: pkg.files.get(pkg.applet)!
  }
}

/**
 * Assemble the signed(-optional) BR-BCT + MB1-BCT, boot images, and recovery
 * applet for a T186 (Jetson TX2) package — the v2 equivalent of
 * {@link buildV1BootPackage}. Both BCTs are byte-identical to `tegrabct_v2`
 * output (validated against the p2771 goldens). The MB1-BCT is odmData-
 * independent; `odmData` lands only in the BR-BCT and defaults to the value
 * `flash.sh` computes. Zero-key devkits ship the BCTs unhashed (flash.sh does
 * not sign them), so no signer is applied here.
 */
export function buildV2BootPackage(
  pkg: FlashPackage,
  options: { odmData?: number } = {}
): TegraBootPackage {
  if (pkg.chip !== Chip.T186) {
    throw new BctError('buildV2BootPackage requires a T186 flash package')
  }
  const flashSh = text(pkg.files, 'flash.sh')
  const cfgs = parseV2CfgSet(flashSh, pkg.files)
  const cfg = (name: string): string => text(pkg.files, name)

  const brBct = assembleBrBct({
    devParams: parseT186DevParams(cfg(cfgs.devParams)),
    odmData: options.odmData ?? parseV2OdmData(flashSh)
  })

  const scratchLayout: SdramScratchLayout = T186_SDRAM_SCRATCH
  const mb1Bct = assembleMb1Bct({
    header: T186_MB1_HEADER,
    sdramSets: parseSdramCfg(cfg(cfgs.sdram), T186_SDRAM_CFG_LAYOUT),
    scratchLayout,
    fragments: {
      pinmux: packMb1Fragment(parseRegisterPairs(cfg(cfgs.pinmux), 'pinmux')),
      scr: packScrFragment(parseScrFragment(cfg(cfgs.scrColdBoot))),
      pad: packMb1Fragment(parseRegisterPairs(cfg(cfgs.pmc), 'pmc')),
      pmic: packPmicFragment(parsePmicCfg(cfg(cfgs.pmic))),
      brcommand: packBrCommandFragment(parseBrCommandCfg(cfg(cfgs.brCommand))),
      prod: packMb1Fragment(parseRegisterTriples(cfg(cfgs.prod)))
    }
  })

  return {
    bcts: [brBct, mb1Bct],
    bootImages: parseV2Bins(flashSh, pkg.files).map((name) => pkg.files.get(name)!),
    executePayload: pkg.files.get(pkg.applet)!
  }
}
