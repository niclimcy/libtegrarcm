import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { Chip, RcmOpcode } from '../src/constants'
import { TegraDevice } from '../src/device'
import { FlashOptions, FlashProgress, RcmFlasher } from '../src/flash'
import { t194SecureRange, T210_PAYLOAD_OFFSET, t210SecureRange } from '../src/rcm'
import { sbkHash } from '../src/sign'
import { readUint32LE } from '../src/utils/bytes'
import { bytes, createFakeTransport } from './fixtures'

function golden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./golden/${name}`, import.meta.url))))
}

/** Reassemble the chunked bulk-OUT transfers into whole messages by length. */
function concatSent(sent: Uint8Array[]): Uint8Array {
  const total = sent.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of sent) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const OK_STATUS = bytes(0, 0, 0, 0)

function setup(options: FlashOptions = {}) {
  const fake = createFakeTransport()
  const device = new TegraDevice(fake.transport)
  const progress: FlashProgress[] = []
  const flasher = new RcmFlasher(device, { onProgress: (p) => progress.push(p), ...options })
  return { fake, flasher, progress }
}

describe('RcmFlasher', () => {
  test('runs read-uid -> program-bct -> stream-images -> finish in order', async () => {
    const { fake, flasher, progress } = setup()
    const uid = bytes(...Array.from({ length: 16 }, (_, i) => i))
    fake.queueBulkIn(uid) // readUid
    fake.queueBulkIn(OK_STATUS) // program-bct
    fake.queueBulkIn(OK_STATUS) // image 0

    const result = await flasher.flash({
      bct: new Uint8Array(64),
      bootImages: [new Uint8Array(32)]
    })

    expect(result.uid).toEqual(uid)
    const stages = progress.map((p) => p.stage)
    expect(stages).toEqual(
      expect.arrayContaining(['read-uid', 'program-bct', 'stream-images', 'finish'])
    )
    expect(stages.indexOf('program-bct')).toBeLessThan(stages.indexOf('stream-images'))
    expect(stages.at(-1)).toBe('finish')
  })

  test('streams both T186 BCTs (bcts array) via ProgramBct, in order, before images', async () => {
    // large chunk so each framed message goes out as a single bulk-OUT
    const { fake, flasher, progress } = setup({ chip: Chip.T186, usbChunkSize: 1 << 20 })
    fake.queueBulkIn(bytes(...Array.from({ length: 16 }, (_, i) => i))) // readUid
    fake.queueBulkIn(OK_STATUS) // program-bct (BR-BCT)
    fake.queueBulkIn(OK_STATUS) // program-bct (MB1-BCT)
    fake.queueBulkIn(OK_STATUS) // image 0

    const brBct = new Uint8Array(0xe00).fill(0x11)
    const mb1Bct = new Uint8Array(0x100).fill(0x22)
    await flasher.flash({ bcts: [brBct, mb1Bct], bootImages: [new Uint8Array(8)] })

    const programBctEvents = progress.filter((p) => p.stage === 'program-bct')
    expect(programBctEvents.length).toBeGreaterThanOrEqual(2)
    // two distinct framed ProgramBct messages went out before the image
    // (T186 RCM header carries the wire opcode at 0x540; ProgramBct passes through)
    const messages = fake.sent.filter(
      (m) => m.length > 0x544 && readUint32LE(m, 0x540) === RcmOpcode.ProgramBct
    )
    expect(messages).toHaveLength(2)
    const stages = progress.map((p) => p.stage)
    expect(stages.lastIndexOf('program-bct')).toBeLessThan(stages.indexOf('stream-images'))
  })

  test('reports cumulative byte progress across boot images', async () => {
    const { fake, flasher, progress } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS) // program-bct
    fake.queueBulkIn(OK_STATUS) // image 0
    fake.queueBulkIn(OK_STATUS) // image 1

    await flasher.flash({
      bct: new Uint8Array(16),
      bootImages: [new Uint8Array(10), new Uint8Array(20)]
    })

    const streamEvents = progress.filter((p) => p.stage === 'stream-images')
    expect(streamEvents.every((p) => p.totalBytes === 30)).toBe(true)
    expect(Math.max(...streamEvents.map((p) => p.bytesTransferred ?? 0))).toBe(30)
  })

  test('throws on a non-zero RCM status', async () => {
    const { fake, flasher } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(bytes(4, 0, 0, 0)) // program-bct failed

    await expect(flasher.flash({ bct: new Uint8Array(16), bootImages: [] })).rejects.toThrow(
      /program-bct failed with RCM status 0x4/
    )
  })

  test('signs and frames the BCT message before sending', async () => {
    const { fake, flasher } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({ bct: new Uint8Array(8), bootImages: [] })

    // one framed message went out; its header carries the message length
    expect(fake.sent).toHaveLength(1)
    const message = fake.sent[0]!
    expect(readUint32LE(message, 0)).toBe(message.length)
  })

  test('default sbkSigner writes the zero-key CMAC into the object hash field', async () => {
    const { fake, flasher } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({ bct: new Uint8Array(8), bootImages: [] })

    const message = fake.sent[0]!
    const expected = await sbkHash(t210SecureRange(message))
    expect(message.slice(0x004, 0x014)).toEqual(expected)
  })

  test('queryVersion: true reads the bootrom version into the result', async () => {
    const { fake, flasher } = setup({ queryVersion: true })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(bytes(0x01, 0x00, 0x21, 0x00)) // version reply
    fake.queueBulkIn(OK_STATUS) // program-bct

    const result = await flasher.flash({ bct: new Uint8Array(16), bootImages: [] })

    expect(result.bootRomVersion).toBe(0x00210001)
    expect(fake.sent[0] && readUint32LE(fake.sent[0], 0x258)).toBe(RcmOpcode.QueryBootRomVersion)
  })

  test('execute sends DownloadExecute with the chip default entry point', async () => {
    const { fake, flasher } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS) // program-bct
    fake.queueBulkIn(OK_STATUS) // execute

    const payload = new Uint8Array(16).fill(7)
    await flasher.flash({ bct: new Uint8Array(8), bootImages: [], executePayload: payload })

    const message = fake.sent.at(-1)!
    expect(readUint32LE(message, 0x258)).toBe(RcmOpcode.DownloadExecute)
    expect(readUint32LE(message, 0x268)).toBe(0x40010000) // T210 applet load address
    expect(message.slice(0x2a8, 0x2a8 + 16)).toEqual(payload)
  })

  test('execute honors an explicit entry point', async () => {
    const { fake, flasher } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({
      bct: new Uint8Array(8),
      bootImages: [],
      executePayload: new Uint8Array(4),
      executeEntryPoint: 0x83000000
    })

    expect(readUint32LE(fake.sent.at(-1)!, 0x268)).toBe(0x83000000)
  })

  test('the chip option selects the applet load address (T132)', async () => {
    const { fake, flasher } = setup({ chip: Chip.T132 })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({
      bct: new Uint8Array(8),
      bootImages: [],
      executePayload: new Uint8Array(4)
    })

    expect(readUint32LE(fake.sent.at(-1)!, 0x268)).toBe(0x4000f000)
  })

  test('splits messages into usbChunkSize bulk transfers with monotonic progress', async () => {
    const { fake, flasher, progress } = setup({ usbChunkSize: 256 })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({ bct: new Uint8Array(16), bootImages: [] })

    // the framed BCT message is 1032 bytes -> 4 full chunks + an 8-byte tail
    expect(fake.sent.map((chunk) => chunk.length)).toEqual([256, 256, 256, 256, 8])
    const sentBytes = progress
      .filter((p) => p.stage === 'program-bct')
      .map((p) => p.bytesTransferred)
    expect(sentBytes).toEqual([256, 512, 768, 1024, 1032])
  })

  test('clamps stream-images progress to the image size, not the framed message', async () => {
    const { fake, flasher, progress } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS) // program-bct
    fake.queueBulkIn(OK_STATUS) // image 0

    // the 32-byte image is framed into a 1032-byte message
    await flasher.flash({ bct: new Uint8Array(8), bootImages: [new Uint8Array(32)] })

    const events = progress.filter((p) => p.stage === 'stream-images')
    expect(events.every((p) => (p.bytesTransferred ?? 0) <= 32)).toBe(true)
    expect(events.at(-1)!.bytesTransferred).toBe(32)
  })

  test('stream-images progress tracks image bytes on the wire, not header bytes', async () => {
    // Regression: the frame is header(0x2a8) + image + padding. Progress must
    // reflect image-payload bytes sent, not raw frame bytes — otherwise it
    // reports 100% while the header is still being transmitted.
    const imageLen = 512
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport)
    const samples: { bytes: number; wire: number }[] = []
    const flasher = new RcmFlasher(device, {
      usbChunkSize: 128,
      onProgress: (p) => {
        if (p.stage === 'stream-images') {
          samples.push({
            bytes: p.bytesTransferred ?? 0,
            wire: fake.sent.reduce((sum, chunk) => sum + chunk.length, 0)
          })
        }
      }
    })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS) // program-bct
    fake.queueBulkIn(OK_STATUS) // image 0

    await flasher.flash({ bct: new Uint8Array(8), bootImages: [new Uint8Array(imageLen)] })

    // Wire count is cumulative across the whole flash; baseline it to the start
    // of image streaming (the first stream-images emit, before any image chunk).
    const baseline = samples[0]!.wire
    const rel = samples.map((s) => ({ bytes: s.bytes, wire: s.wire - baseline }))

    // No emit may claim more image bytes than have cleared the frame header.
    for (const s of rel) {
      expect(s.bytes).toBeLessThanOrEqual(Math.max(0, s.wire - T210_PAYLOAD_OFFSET))
    }
    // While mid-header, zero image bytes are reported (the old bug reported >0).
    const midHeader = rel.filter((s) => s.wire > 0 && s.wire <= T210_PAYLOAD_OFFSET)
    expect(midHeader.length).toBeGreaterThan(0)
    expect(midHeader.every((s) => s.bytes === 0)).toBe(true)
    // Full image count is reported only once the payload has actually been sent.
    expect(rel.at(-1)!.bytes).toBe(imageLen)
  })

  test('uses a custom signer for every message', async () => {
    const signer = vi.fn((message: Uint8Array<ArrayBuffer>) => {
      message.set([0xde, 0xad], 0x004)
      return Promise.resolve()
    })
    const { fake, flasher } = setup({ signer })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS) // program-bct
    fake.queueBulkIn(OK_STATUS) // image 0
    fake.queueBulkIn(OK_STATUS) // execute

    await flasher.flash({
      bct: new Uint8Array(8),
      bootImages: [new Uint8Array(4)],
      executePayload: new Uint8Array(4)
    })

    expect(signer).toHaveBeenCalledTimes(3)
    for (const message of fake.sent) {
      expect(Array.from(message.slice(0x004, 0x006))).toEqual([0xde, 0xad])
    }
  })

  test('works without an onProgress callback', async () => {
    const fake = createFakeTransport()
    const flasher = new RcmFlasher(new TegraDevice(fake.transport))
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)

    await expect(flasher.flash({ bct: new Uint8Array(8), bootImages: [] })).resolves.toBeDefined()
  })

  test('accepts construction for T234 and T264 chips', () => {
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport)
    expect(() => new RcmFlasher(device, { chip: Chip.T234 })).not.toThrow()
    expect(() => new RcmFlasher(device, { chip: Chip.T264 })).not.toThrow()
  })

  test('skips program-bct when the package has no BCT', async () => {
    const { fake, flasher, progress } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS) // execute

    await flasher.flash({ executePayload: new Uint8Array(4) })

    expect(progress.map((p) => p.stage)).toEqual(['read-uid', 'execute', 'finish'])
    expect(fake.sent).toHaveLength(1)
  })

  test('T186 queryVersion sends the wire query opcode 7, not the logical 6', async () => {
    // NvTegraT18xRcmMapOpCode: the version query is wire opcode 7 on T186
    // (confirmed by the t186_rcm_0.rcm golden's opcode field).
    const { fake, flasher } = setup({ chip: Chip.T186, queryVersion: true })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(bytes(0x01, 0x00, 0x18, 0x00)) // version reply

    await flasher.flash({})

    expect(readUint32LE(fake.sent[0]!, 0x540)).toBe(7)
  })

  test('throws RcmError on a short status reply', async () => {
    const { fake, flasher } = setup()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(bytes(0, 0)) // truncated status

    await expect(flasher.flash({ bct: new Uint8Array(8), bootImages: [] })).rejects.toThrow(
      /short RCM status: 2 bytes/
    )
  })
})

describe('T194 flash flow (applet hand-off)', () => {
  test('flash runs read-uid -> query-version -> execute with the T194 wire opcodes', async () => {
    const { fake, flasher, progress } = setup({ chip: Chip.T194, queryVersion: true })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(bytes(0x01, 0x00, 0x19, 0x00)) // version reply
    fake.queueBulkIn(OK_STATUS) // execute

    const result = await flasher.flash({ executePayload: new Uint8Array(64).fill(7) })

    expect(result.bootRomVersion).toBe(0x00190001)
    const stages = progress.map((p) => p.stage).filter((s, i, all) => s !== all[i - 1])
    expect(stages).toEqual(['read-uid', 'query-version', 'execute', 'finish'])
    // query message: wire opcode 7 @0x6d0, header-only (0x7b0 bytes)
    expect(fake.sent[0]!.length).toBe(0x7b0)
    expect(readUint32LE(fake.sent[0]!, 0x6d0)).toBe(7)
    // download message: wire opcode 5, applet entry 0x40020000, payload @0x7b0
    const download = fake.sent[1]!
    expect(readUint32LE(download, 0x6d0)).toBe(5)
    expect(readUint32LE(download, 0x700)).toBe(0x40020000)
    expect(download.subarray(0x7b0)).toEqual(new Uint8Array(64).fill(7))
  })

  test('unsigned download message matches the tegrarcm_v2 golden byte-for-byte', async () => {
    // The same 256-byte 0xAA payload t194_rcm_1.rcm was generated from. A no-op
    // signer leaves the message exactly as tegrarcm_v2 --listrcm emits it.
    const { fake, flasher } = setup({ chip: Chip.T194, signer: async () => {} })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({ executePayload: new Uint8Array(256).fill(0xaa) })

    expect(Buffer.from(concatSent(fake.sent)).equals(Buffer.from(golden('t194_rcm_1.rcm')))).toBe(
      true
    )
  })

  test('default sbkSigner writes the zero-key CMAC over the 256-byte secure header', async () => {
    const { fake, flasher } = setup({ chip: Chip.T194 })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    fake.queueBulkIn(OK_STATUS)

    await flasher.flash({ executePayload: new Uint8Array(16) })

    const message = concatSent(fake.sent)
    const expected = await sbkHash(t194SecureRange(message))
    expect(message.slice(0x004, 0x014)).toEqual(expected)
  })

  test('rejects a package with a BCT: the T194 program-bct wire opcode is unknown', async () => {
    const { fake, flasher } = setup({ chip: Chip.T194 })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))

    await expect(
      flasher.flash({ bct: new Uint8Array(16), executePayload: new Uint8Array(4) })
    ).rejects.toThrow(/T194 wire opcode .* unknown/)
  })

  test('rejects boot images: the T194 program-bootloader wire opcode is unknown', async () => {
    const { fake, flasher } = setup({ chip: Chip.T194 })
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))

    await expect(flasher.flash({ bootImages: [new Uint8Array(4)] })).rejects.toThrow(
      /T194 wire opcode .* unknown/
    )
  })
})
