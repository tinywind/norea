interface AndroidBridgeInfoBridge {
  nonce: () => string;
  session: () => string;
}

declare global {
  interface Window {
    __NoreaAndroidBridge?: AndroidBridgeInfoBridge;
  }
}

export interface AndroidBridgeAuthority {
  capability: string;
  nonce: string;
  sessionToken: string;
}

export function androidBridgeAuthority(
  capability: string,
): AndroidBridgeAuthority {
  const bridge = window.__NoreaAndroidBridge;
  if (!bridge) {
    throw new Error("Android bridge session is unavailable.");
  }

  let session: unknown;
  try {
    session = JSON.parse(bridge.session());
  } catch {
    throw new Error("Android bridge session is invalid.");
  }
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("Android bridge session is invalid.");
  }
  const values = session as Record<string, unknown>;
  const sessionToken = requiredString(values.sessionToken, "sessionToken");
  const capabilities = values.capabilities;
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((item) => typeof item === "string") ||
    !capabilities.includes(capability)
  ) {
    throw new Error("Android bridge capability is unavailable.");
  }

  return {
    capability,
    nonce: requiredString(bridge.nonce(), "nonce"),
    sessionToken,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Android bridge ${field} is invalid.`);
  }
  return value;
}
