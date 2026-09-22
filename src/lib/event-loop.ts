export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
