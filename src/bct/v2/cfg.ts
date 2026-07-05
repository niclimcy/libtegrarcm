import { BctError } from '../../errors'

/** A numeric cfg literal: hex (`0x1a`) or bare decimal. */
export const NUM_RE = '(0x[0-9a-fA-F]+|\\d+)'

/**
 * cfg command indices are parsed into a sparse array by `arr[i] = …`; a skipped
 * index leaves a hole that later packing derefs as `undefined`. Reject it here
 * with the offending index instead of crashing mid-assembly.
 */
export function assertContiguous(items: unknown[], what: string): void {
  for (let i = 0; i < items.length; i++) {
    if (items[i] === undefined) throw new BctError(`${what} missing index ${i}`)
  }
}
