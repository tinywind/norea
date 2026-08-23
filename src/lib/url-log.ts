const HTTP_URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;

export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
    return `<${parsed.protocol.slice(0, -1) || "non-http"}-url>`;
  } catch {
    if (/^https?:\/\//i.test(url)) return "<http-url>";
    const secretBoundary = url.search(/[?#]/);
    const withoutSecrets =
      secretBoundary >= 0 ? url.slice(0, secretBoundary) : url;
    return withoutSecrets.replace(
      /^([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/i,
      "$1",
    );
  }
}

export function redactUrlsForLog(message: string): string {
  return message.replace(HTTP_URL_IN_TEXT, redactUrlForLog);
}
