<script setup lang="ts">
import {
  buildV1BootPackage,
  chipProfile,
  RcmFlasher,
  requestDevice,
  TegraDevice,
  type FlashPackage,
  type FlashProgress,
  type TegraBootPackage
} from 'libtegrarcm'
import { Chip } from 'libtegrarcm/constants'
import { computed, ref, shallowRef } from 'vue'
import { buildBootPackage, needsV1Selection, openFlashPackage } from './flashPackage'

const chipName = (chip: number): string =>
  Object.entries(Chip).find(([, id]) => id === chip)?.[0] ?? `0x${chip.toString(16)}`

const device = shallowRef<TegraDevice | null>(null)
const uid = ref<string>('')
const status = ref<string>('')
const busy = ref(false)

const tab = ref<'package' | 'manual'>('package')

const pkg = shallowRef<FlashPackage | null>(null)
const pkgName = ref<string>('')
const sdramCfg = ref<string>('')
const layout = ref<string>('')
const progress = ref<string[]>([])

const manualBctFile = ref<File | null>(null)
const manualBrBctFile = ref<File | null>(null)
const manualMb1BctFile = ref<File | null>(null)
const manualPayloadFile = ref<File | null>(null)
const manualBootImages = ref<File[]>([])
const manualEntryPoint = ref<string>('')
const manualOdmData = ref<string>('')
const manualLayoutFile = ref<File | null>(null)

const connectedChipId = computed<number | null>(() => {
  if (!device.value || !device.value.usbDevice) return null
  return device.value.usbDevice.productId & 0xff
})

const detectedChip = computed<Chip | null>(() => {
  const cid = connectedChipId.value
  if (cid === null) return null
  const supported: number[] = [
    Chip.T124,
    Chip.T132,
    Chip.T210,
    Chip.T186,
    Chip.T194,
    Chip.T234,
    Chip.T264
  ]
  return supported.includes(cid) ? (cid as Chip) : null
})

const detectedFamily = computed<'v1' | 'v2' | null>(() => {
  if (!detectedChip.value) return null
  return chipProfile(detectedChip.value).family
})

const chipFriendlyName = (chip: Chip): string => {
  switch (chip) {
    case Chip.T124:
      return 'T124 (Tegra K1)'
    case Chip.T132:
      return 'T132 (Tegra K1 64-bit)'
    case Chip.T210:
      return 'T210 (Tegra X1)'
    case Chip.T186:
      return 'T186 (Tegra X2)'
    case Chip.T194:
      return 'T194 (Tegra Xavier)'
    case Chip.T234:
      return 'T234 (Tegra Orin)'
    case Chip.T264:
      return 'T264 (Tegra Thor)'
    default:
      return `0x${(chip as number).toString(16)}`
  }
}

const isAppletHandOff = (chip: Chip | null): boolean => {
  return chip !== null && ([Chip.T194, Chip.T234, Chip.T264] as Chip[]).includes(chip)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function run(label: string, fn: () => Promise<void>) {
  busy.value = true
  status.value = `${label}…`
  try {
    await fn()
    status.value = label
  } catch (err) {
    status.value = `error: ${(err as Error).message}`
  } finally {
    busy.value = false
  }
}

function connect() {
  return run('connected', async () => {
    const dev = await requestDevice({ logging: true })
    await dev.connect()
    device.value = dev
  })
}

function readUid() {
  return run('read device id', async () => {
    if (!device.value) return
    uid.value = hex(await device.value.readUid())
  })
}

function onPackage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  return run(`opened ${file.name}`, async () => {
    pkg.value = null
    pkgName.value = file.name
    const opened = await openFlashPackage(file)
    sdramCfg.value = opened.sdramCfgs[0] ?? ''
    layout.value = opened.layouts[0] ?? ''
    pkg.value = opened
  })
}

function handleFileChange(
  event: Event,
  type: 'bct' | 'brbct' | 'mb1bct' | 'payload' | 'images' | 'layout'
) {
  const files = (event.target as HTMLInputElement).files
  if (type === 'images') {
    if (files) {
      manualBootImages.value = [...manualBootImages.value, ...Array.from(files)]
    }
    ;(event.target as HTMLInputElement).value = ''
  } else {
    const file = files?.[0] || null
    if (type === 'bct') manualBctFile.value = file
    else if (type === 'brbct') manualBrBctFile.value = file
    else if (type === 'mb1bct') manualMb1BctFile.value = file
    else if (type === 'payload') manualPayloadFile.value = file
    else if (type === 'layout') manualLayoutFile.value = file
  }
}

const readBytes = async (file: File) => new Uint8Array(await file.arrayBuffer())
const readBytesAll = (files: File[]) => Promise.all(files.map(readBytes))

function logProgress(p: FlashProgress) {
  const bytes =
    p.totalBytes !== undefined ? ` (${p.bytesTransferred ?? 0}/${p.totalBytes} bytes)` : ''
  progress.value = [...progress.value, `${p.stage}${bytes}`]
}

async function runFlash(chip: Chip, bootPackage: TegraBootPackage) {
  if (!device.value) return
  const flasher = new RcmFlasher(device.value, {
    chip,
    queryVersion: ([Chip.T194, Chip.T234, Chip.T264] as Chip[]).includes(chip),
    onProgress: logProgress
  })
  await flasher.flash(bootPackage)
}

function flash() {
  return run('flash complete', async () => {
    if (!pkg.value) return
    progress.value = []
    const selection = needsV1Selection(pkg.value)
      ? { sdramCfg: sdramCfg.value, layout: layout.value }
      : undefined
    const bootPackage = await buildBootPackage(pkg.value, selection)
    await runFlash(pkg.value.chip, bootPackage)
  })
}

function flashManual() {
  return run('flash complete', async () => {
    if (!device.value || !detectedChip.value) return
    progress.value = []

    let payloadBytes: Uint8Array | undefined = undefined
    if (manualPayloadFile.value) {
      payloadBytes = await readBytes(manualPayloadFile.value)
    }

    let entryPoint: number | undefined = undefined
    const entryPointVal = manualEntryPoint.value.trim()
    if (entryPointVal) {
      entryPoint =
        entryPointVal.startsWith('0x') || entryPointVal.startsWith('0X')
          ? parseInt(entryPointVal, 16)
          : parseInt(entryPointVal, 10)
      if (Number.isNaN(entryPoint)) {
        throw new Error('invalid entry point address')
      }
    }

    let odmData: number | undefined = undefined
    const odmDataVal = manualOdmData.value.trim()
    if (odmDataVal) {
      odmData =
        odmDataVal.startsWith('0x') || odmDataVal.startsWith('0X')
          ? parseInt(odmDataVal, 16)
          : parseInt(odmDataVal, 10)
      if (Number.isNaN(odmData)) {
        throw new Error('invalid ODM data value')
      }
    }

    const bootImageBytes = await readBytesAll(manualBootImages.value)
    let bootPackage: TegraBootPackage

    if (
      detectedFamily.value === 'v1' &&
      manualBctFile.value &&
      payloadBytes &&
      manualPayloadFile.value
    ) {
      const filesMap = new Map<string, Uint8Array>()
      filesMap.set(manualPayloadFile.value.name, payloadBytes)
      for (let i = 0; i < manualBootImages.value.length; i++) {
        const file = manualBootImages.value[i]
        const bytes = bootImageBytes[i]
        if (file && bytes) {
          filesMap.set(file.name, bytes)
        }
      }

      const bctText = await manualBctFile.value.text()
      filesMap.set(manualBctFile.value.name, new TextEncoder().encode(bctText))

      let layoutText: string
      let layoutName = 'layout.xml'
      if (manualLayoutFile.value) {
        layoutText = await manualLayoutFile.value.text()
        layoutName = manualLayoutFile.value.name
      } else {
        layoutText = `
          <partition_layout>
            <device type="sdmmc">
              <partition name="BCT" size="3145728" />
              <partition name="PT" size="2097152" />
              <partition name="EBT" type="bootloader" size="6291456">
                <filename> ${manualPayloadFile.value.name} </filename>
              </partition>
            </device>
          </partition_layout>
        `
      }
      filesMap.set(layoutName, new TextEncoder().encode(layoutText))

      const pkg: FlashPackage = {
        chip: detectedChip.value,
        files: filesMap,
        applet: manualPayloadFile.value.name,
        layouts: [layoutName],
        sdramCfgs: [manualBctFile.value.name],
        ...(odmData !== undefined && { odmData })
      }

      bootPackage = await buildV1BootPackage(
        pkg,
        manualBctFile.value.name,
        layoutName,
        detectedChip.value
      )

      if (entryPoint !== undefined) {
        bootPackage.executeEntryPoint = entryPoint
      }
    } else {
      const bctBytes: Uint8Array[] = []
      if (detectedChip.value === Chip.T186) {
        if (manualBrBctFile.value) bctBytes.push(await readBytes(manualBrBctFile.value))
        if (manualMb1BctFile.value) bctBytes.push(await readBytes(manualMb1BctFile.value))
      }
      bootPackage = {
        ...(bctBytes.length > 1
          ? { bcts: bctBytes }
          : bctBytes.length === 1
            ? { bct: bctBytes[0] }
            : {}),
        bootImages: bootImageBytes.length > 0 ? bootImageBytes : undefined,
        executePayload: payloadBytes,
        executeEntryPoint: entryPoint
      }
    }

    await runFlash(detectedChip.value, bootPackage)
  })
}
</script>

<template>
  <main>
    <h1>libtegrarcm</h1>
    <p>Put a Tegra device into RCM (recovery / APX) mode, then connect.</p>

    <section>
      <div class="row">
        <button :disabled="busy" @click="connect">Connect</button>
        <button :disabled="busy || !device" @click="readUid">Read chip UID</button>
      </div>
      <p v-if="uid" class="uid">
        UID: <code>{{ uid }}</code>
      </p>
    </section>

    <section>
      <h2>Flash</h2>
      <div class="tabs">
        <button :class="{ active: tab === 'package' }" @click="tab = 'package'">
          Flash Package (.txz)
        </button>
        <button :class="{ active: tab === 'manual' }" @click="tab = 'manual'">
          Manual Selection
        </button>
      </div>

      <template v-if="tab === 'package'">
        <p class="hint">
          Choose a <code>*_flash_package.txz</code>. It's extracted in the browser.
        </p>
        <div class="row">
          <label
            >Package: <input type="file" accept=".txz,.xz" :disabled="busy" @change="onPackage"
          /></label>
        </div>

        <template v-if="pkg">
          <p class="hint">
            {{ pkgName }} — {{ chipName(pkg.chip) }}, {{ pkg.files.size }} files, applet
            <code>{{ pkg.applet }}</code>
          </p>
          <template v-if="needsV1Selection(pkg)">
            <div class="row">
              <label>
                SDRAM config:
                <select v-model="sdramCfg" :disabled="busy">
                  <option v-for="name in pkg.sdramCfgs" :key="name">{{ name }}</option>
                </select>
              </label>
            </div>
            <div class="row">
              <label>
                Partition layout:
                <select v-model="layout" :disabled="busy">
                  <option v-for="name in pkg.layouts" :key="name">{{ name }}</option>
                </select>
              </label>
            </div>
            <p class="hint">
              SD-card devkits boot from SPI (the <code>spi_sd</code> layout); eMMC modules use the
              <code>emmc</code> one.
            </p>
          </template>
          <p v-else-if="pkg.chip === Chip.T186" class="hint">
            T186: the BR-BCT and MB1-BCT are compiled from the package's cfg set (no NVIDIA tool)
            and streamed with the boot images and recovery applet — no selection needed.
          </p>
          <p v-else class="hint">
            {{ chipName(pkg.chip) }}: the bootrom downloads-and-executes the recovery applet; the
            rest of flashing runs through the applet's own protocol.
          </p>
          <div class="row">
            <button
              :disabled="busy || !device || (needsV1Selection(pkg) && (!sdramCfg || !layout))"
              @click="flash"
            >
              Flash
            </button>
          </div>
        </template>
      </template>

      <template v-else-if="tab === 'manual'">
        <p class="hint">Manually select files to flash over RCM.</p>
        <div class="row">
          <span v-if="!device">Chip: <em>(Connect a device to detect chip)</em></span>
          <span v-else-if="detectedChip"
            >Chip: <strong>{{ chipFriendlyName(detectedChip) }}</strong></span
          >
          <span v-else>
            Chip:
            <strong style="color: #ff4d4d"
              >Unsupported chip (0x{{ connectedChipId?.toString(16) }})</strong
            >
          </span>
        </div>
        <!-- If T186, show separate BR-BCT and MB1-BCT upload fields -->
        <template v-if="detectedChip === Chip.T186">
          <div class="row">
            <label>
              BR-BCT file:
              <input type="file" :disabled="busy" @change="handleFileChange($event, 'brbct')" />
            </label>
          </div>
          <p class="hint">Optional. Choose the pre-compiled BR-BCT binary.</p>

          <div class="row">
            <label>
              MB1-BCT file:
              <input type="file" :disabled="busy" @change="handleFileChange($event, 'mb1bct')" />
            </label>
          </div>
          <p class="hint">Optional. Choose the pre-compiled MB1-BCT binary.</p>
        </template>

        <!-- Otherwise (unless it's T194 which uses no BCTs), show a single BCT config upload field -->
        <template v-else-if="detectedFamily === 'v1' || !detectedChip">
          <div class="row">
            <label>
              BCT config (.cfg):
              <input type="file" :disabled="busy" @change="handleFileChange($event, 'bct')" />
            </label>
          </div>
          <p class="hint">
            Optional. Choose the board's SDRAM text configuration file (<code>*.cfg</code>) to build
            the BCT dynamically.
          </p>
        </template>
        <div class="row">
          <label>
            Partition layout (.xml / .cfg):
            <input type="file" :disabled="busy" @change="handleFileChange($event, 'layout')" />
          </label>
        </div>
        <p class="hint">
          Optional. Partition layout configuration file (T124 uses <code>.cfg</code>; T210 uses
          <code>.xml</code>). Used to calculate bootloader block offsets.
        </p>
        <div class="row">
          <label>
            Bootloader / Payload:
            <input type="file" :disabled="busy" @change="handleFileChange($event, 'payload')" />
          </label>
        </div>
        <p class="hint">
          <span v-if="detectedFamily === 'v2'"
            >Required. Choose the bootloader or recovery applet binary (e.g.
            <code>rcm_1.rcm</code>).</span
          >
          <span v-else
            >Required. Choose the bootloader or applet binary to download and execute.</span
          >
        </p>
        <div class="row" style="align-items: flex-start">
          <label>
            Boot images:
            <div>
              <input
                type="file"
                multiple
                :disabled="busy || isAppletHandOff(detectedChip)"
                @change="handleFileChange($event, 'images')"
              />
              <ul v-if="manualBootImages.length > 0" class="file-list">
                <li v-for="(file, i) in manualBootImages" :key="i">
                  {{ file.name }}
                  <button type="button" class="remove-btn" @click="manualBootImages.splice(i, 1)">
                    ×
                  </button>
                </li>
              </ul>
            </div>
          </label>
        </div>
        <p class="hint">
          <span v-if="detectedFamily === 'v2'"
            >Optional. Select additional boot images to stream (T186 only; T194/T234/T264: not
            used).</span
          >
          <span v-else>Optional. Select additional boot images / partitions to stream.</span>
        </p>
        <div class="row">
          <label>
            Entry point:
            <input
              v-model="manualEntryPoint"
              type="text"
              placeholder="e.g. 0x40010000"
              :disabled="busy"
            />
          </label>
        </div>
        <p class="hint">
          Optional. Address in memory to execute the payload. Defaults to chip's applet load
          address.
        </p>
        <div class="row">
          <label>
            ODM data:
            <input
              v-model="manualOdmData"
              type="text"
              placeholder="e.g. 0x12498008"
              :disabled="busy || isAppletHandOff(detectedChip)"
            />
          </label>
        </div>
        <p class="hint">
          Optional. 32-bit hex or decimal value for board-specific ODM configuration (V1 and T186).
        </p>
        <div class="row">
          <button
            :disabled="busy || !device || !detectedChip || !manualPayloadFile"
            @click="flashManual"
          >
            Flash
          </button>
        </div>
      </template>

      <ul v-if="progress.length" class="progress">
        <li v-for="(line, i) in progress" :key="i">{{ line }}</li>
      </ul>
    </section>

    <p v-if="status" class="status">{{ status }}</p>
  </main>
</template>

<style>
:root {
  color-scheme: light dark;
  --border: color-mix(in srgb, currentColor 20%, transparent);
  --surface: color-mix(in srgb, currentColor 7%, transparent);
}

body {
  font-family: system-ui, sans-serif;
  max-width: 64rem;
  margin: 0 auto;
  padding: 1.5rem;
  line-height: 1.5;
}

h1 {
  font-size: 1.5rem;
  margin-bottom: 0.25rem;
}

h2 {
  font-size: 1.1rem;
  margin-top: 0;
  margin-bottom: 0.5rem;
}

button,
input[type='file']::file-selector-button {
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background-color: var(--surface);
  font: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}

button:enabled:hover,
input[type='file']::file-selector-button:hover {
  background-color: color-mix(in srgb, currentColor 14%, transparent);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

input[type='number'],
input[type='text'],
select {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background-color: transparent;
  font: inherit;
  font-size: 0.9rem;
}

input[type='file'] {
  font-size: 0.85rem;
}

input[type='file']::file-selector-button {
  margin-right: 0.625rem;
}

section {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  margin: 0.5rem 0;
}

.status {
  color: color-mix(in srgb, currentColor 60%, transparent);
  margin-top: 1rem;
}

.hint {
  color: color-mix(in srgb, currentColor 60%, transparent);
  font-size: 0.9rem;
  margin: 0.5rem 0;
}

.uid code {
  font-family: ui-monospace, monospace;
  word-break: break-all;
  background-color: var(--surface);
  padding: 0.2rem 0.4rem;
  border-radius: 0.25rem;
}

.progress {
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
  color: color-mix(in srgb, currentColor 60%, transparent);
  font-size: 0.85rem;
  font-family: ui-monospace, monospace;
}

.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.5rem;
}

.tabs button {
  background: transparent;
  border: none;
  border-radius: 0.375rem;
  padding: 0.4rem 0.8rem;
  font-weight: 500;
  color: color-mix(in srgb, currentColor 60%, transparent);
}

.tabs button.active {
  background: var(--surface);
  color: currentColor;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.file-list {
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
  font-size: 0.85rem;
}

.file-list li {
  margin-bottom: 0.25rem;
  color: color-mix(in srgb, currentColor 80%, transparent);
}

.remove-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  color: #ef4444;
  margin-left: 0.5rem;
  font-weight: bold;
  padding: 0 0.25rem;
}
</style>
