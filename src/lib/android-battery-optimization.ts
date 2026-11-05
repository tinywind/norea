interface AndroidBatteryOptimizationBridge {
  isIgnoring: () => boolean;
  request: () => boolean;
}

declare global {
  interface Window {
    __NoreaAndroidBatteryOptimization?: AndroidBatteryOptimizationBridge;
  }
}

function bridge(): AndroidBatteryOptimizationBridge | undefined {
  return typeof window === "undefined" ? undefined : window.__NoreaAndroidBatteryOptimization;
}

/** Whether Android exempts Norea from battery optimization; null outside the Android host. */
export function androidBatteryOptimizationExempt(): boolean | null {
  return bridge()?.isIgnoring() ?? null;
}

/** Opens Android's exemption prompt; false when no battery settings screen could open. */
export function requestAndroidBatteryOptimizationExemption(): boolean {
  return bridge()?.request() ?? false;
}
