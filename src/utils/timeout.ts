/** Rejects with `reason` if `promise` doesn't settle within `ms`. */
export const timeoutPromise = <T>(promise: Promise<T>, reason: string, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms)
  })
  // Cancel the timer once the race settles, so a fast bulk transfer doesn't
  // leave a live timer per call keeping the event loop busy for `ms`.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
