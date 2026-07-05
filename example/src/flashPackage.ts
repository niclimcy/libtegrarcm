import {
  buildV1BootPackage,
  buildV2BootPackage,
  parseFlashPackageTar,
  type FlashPackage,
  type TegraBootPackage
} from 'libtegrarcm'
import { Chip } from 'libtegrarcm/constants'
import { XzReadableStream } from 'xz-decompress'

/**
 * In-browser handling of a board flash package (`*_flash_package.txz`):
 * decompress the `.txz` in the browser, then hand the tar to the library, which
 * reads `flash.sh`, compiles the BCT(s) from the board `.cfg`s / partition
 * layout, and bundles the boot images + recovery applet — the `tegraparser` +
 * `tegrabct(_v2)` + `tegrasign` job, no NVIDIA tool.
 *
 * Every chip the library can drive over RCM is handled: the v1 BCT family
 * (T124/T132/T210, one flat BCT) via {@link buildV1BootPackage}, T186 (v2,
 * BR-BCT + MB1-BCT) via {@link buildV2BootPackage}, and T194 as the applet
 * hand-off (the bootrom just downloads-and-executes the recovery applet; the
 * rest of flashing runs through it). T234/T264 have no host-buildable RCM
 * framing, so `parseFlashPackageTar` rejects them.
 */

/** Decompress a `.txz` in the browser and parse it (chip, applet, cfgs, layouts). */
export async function openFlashPackage(file: File): Promise<FlashPackage> {
  const tar = await new Response(new XzReadableStream(file.stream())).arrayBuffer()
  return parseFlashPackageTar(new Uint8Array(tar))
}

/** The v1 BCT family — a flat BCT built from an SDRAM cfg + partition layout. */
const V1_CHIPS: ReadonlySet<number> = new Set([Chip.T124, Chip.T132, Chip.T210])

/** A v1 package needs an SDRAM cfg + partition layout picked from its candidates. */
export interface V1Selection {
  sdramCfg: string
  layout: string
}

/** True when the package needs a v1 SDRAM cfg / partition layout selection. */
export function needsV1Selection(pkg: FlashPackage): boolean {
  return V1_CHIPS.has(pkg.chip)
}

/**
 * Build the flashable boot package for whichever generation the chip uses:
 * v1 (T124/T132/T210) needs the SDRAM cfg + partition layout the UI selected;
 * T186 (v2) is fully determined by `flash.sh`; T194 is just the recovery applet
 * (no BCT built here — the bootrom hands off to it).
 */
export function buildBootPackage(
  pkg: FlashPackage,
  selection?: V1Selection
): Promise<TegraBootPackage> {
  if (V1_CHIPS.has(pkg.chip)) {
    if (!selection?.sdramCfg || !selection.layout) {
      return Promise.reject(new Error('this chip needs an SDRAM config and a partition layout'))
    }
    return buildV1BootPackage(pkg, selection.sdramCfg, selection.layout, pkg.chip)
  }
  if (pkg.chip === Chip.T186) return Promise.resolve(buildV2BootPackage(pkg))
  if (([Chip.T194, Chip.T234, Chip.T264] as Chip[]).includes(pkg.chip)) {
    // applet hand-off: read UID → (query version) → download-and-execute
    return Promise.resolve({ executePayload: pkg.files.get(pkg.applet)! })
  }
  return Promise.reject(new Error(`no flash path for chip 0x${pkg.chip.toString(16)}`))
}
