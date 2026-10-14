export class SourceCooldowns {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly untilByKey = new Map<string, number>();

  constructor(private readonly drain: () => void) {}

  delay(key: string | undefined): number {
    if (!key) return 0;
    const until = this.untilByKey.get(key);
    if (!until) return 0;
    const delay = until - Date.now();
    if (delay > 0) return delay;
    this.clear(key);
    return 0;
  }

  set(key: string | undefined, cooldownMs: number): void {
    if (!key || cooldownMs <= 0) return;
    const delayMs = Math.max(0, Math.round(cooldownMs));
    this.clear(key);
    this.untilByKey.set(key, Date.now() + delayMs);
    this.scheduleDrain(key, delayMs);
  }

  clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.untilByKey.delete(key);
  }

  scheduleDrain(key: string, delayMs: number): void {
    if (this.timers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        const until = this.untilByKey.get(key);
        if (until !== undefined && until <= Date.now())
          this.untilByKey.delete(key);
        this.drain();
      },
      Math.max(0, delayMs),
    );
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.timers.set(key, timer);
  }
}
