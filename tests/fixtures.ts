import { UsbTransport } from '../src/transport'

/** A scriptable in-memory {@link UsbTransport} for tests (no real WebUSB). */
export function createFakeTransport() {
  const sent: Uint8Array[] = []
  const bulkInQueue: (Uint8Array<ArrayBuffer> | Error)[] = []
  const disconnectCallbacks: (() => void)[] = []
  const controlTransfers: { setup: USBControlTransferParameters; length: number }[] = []
  let connected = false

  const transport = {
    connect: () => {
      connected = true
      return Promise.resolve()
    },
    bulkOut: (data: Uint8Array<ArrayBuffer>) => {
      sent.push(data.slice())
      return Promise.resolve()
    },
    bulkIn: () => {
      const reply = bulkInQueue.shift()
      if (reply === undefined) return Promise.reject(new Error('no bulk reply queued'))
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply)
    },
    controlTransferIn: (setup: USBControlTransferParameters, length: number) => {
      controlTransfers.push({ setup, length })
      return Promise.resolve(new Uint8Array(length))
    },
    close: () => {
      connected = false
      return Promise.resolve()
    },
    onDisconnect: (callback: () => void) => {
      disconnectCallbacks.push(callback)
    }
  } satisfies UsbTransport

  return {
    transport,
    sent,
    controlTransfers,
    /** Queue bytes (or an Error) to be returned by the next bulkIn call. */
    queueBulkIn: (reply: Uint8Array<ArrayBuffer> | Error) => bulkInQueue.push(reply),
    fireDisconnect: () => disconnectCallbacks.forEach((cb) => cb()),
    isConnected: () => connected
  }
}

/** Build a Uint8Array<ArrayBuffer> from byte values. */
export function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values)
}

/** Parse a hex string ("aabbcc") into bytes. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Render bytes as a lowercase hex string. */
export function toHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')
}
