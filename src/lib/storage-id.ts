export function isStorageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 240 &&
    !/^[. ]|[. ]$|[\u0000-\u001f<>:"/\\|?*]/.test(value) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) &&
    !/(?:\.tmp|\.bak|\.part|\.partial|\.norea-sync-backup)$/i.test(value) &&
    !Array.from(value).some(character => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    });
}
