import { base64ToByteChunksCooperatively, base64ToBytes } from "../base64";
import { sourceAccessErrorFromEnvelope } from "../plugins/source-access";
import { type FetchResultWire, type PluginHttpInit } from "./types";

const CLOUDFLARE_BODY_INSPECTION_BYTES = 512 * 1024;

async function bodyFromWire(
  result: FetchResultWire,
  signal?: AbortSignal,
): Promise<BodyInit> {
  if (result.bodyBase64 !== undefined) {
    return new Blob(
      await base64ToByteChunksCooperatively(result.bodyBase64, signal),
    );
  }
  return result.body ?? "";
}

async function responseFromWire(
  result: FetchResultWire,
  signal?: AbortSignal,
): Promise<Response> {
  const response = new Response(await bodyFromWire(result, signal), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  Object.defineProperty(response, "url", {
    value: result.finalUrl,
    configurable: true,
  });
  return response;
}

function wireHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function wireTextBody(result: FetchResultWire): string {
  if (result.body !== undefined) return result.body;
  if (result.bodyBase64 === undefined) return "";
  try {
    const encodedLength = Math.ceil(CLOUDFLARE_BODY_INSPECTION_BYTES / 3) * 4;
    return new TextDecoder().decode(
      base64ToBytes(result.bodyBase64.slice(0, encodedLength)),
    );
  } catch {
    return "";
  }
}

function isCloudflareChallengeResponse(result: FetchResultWire): boolean {
  if (result.cloudflareChallenge) return true;
  if (
    wireHeader(result.headers, "cf-mitigated")?.toLowerCase() === "challenge"
  ) {
    return true;
  }
  const contentType = wireHeader(result.headers, "content-type")?.toLowerCase();
  if (!contentType?.includes("text/html")) return false;
  const body = wireTextBody(result).slice(0, CLOUDFLARE_BODY_INSPECTION_BYTES);
  return (
    /\/cdn-cgi\/challenge-platform\//i.test(body) ||
    /\b(?:cf-chl-|__cf_chl_)/i.test(body) ||
    /id=["']challenge-(?:form|running|stage)["']/i.test(body) ||
    (/cloudflare ray id/i.test(body) &&
      /attention required|sorry, you have been blocked/i.test(body))
  );
}

export function cloudflareAccessError(
  result: FetchResultWire,
  requestUrl: string,
): Error | null {
  if (!isCloudflareChallengeResponse(result)) return null;
  return sourceAccessErrorFromEnvelope(
    {
      ok: false,
      code: "manual-action-required",
      error: "Cloudflare verification is required.",
      challenge: {
        kind: "cloudflare",
        url: result.finalUrl || requestUrl,
      },
    },
    requestUrl,
  );
}

export async function checkedResponseFromWire(
  result: FetchResultWire,
  requestUrl: string,
  signal?: AbortSignal,
): Promise<Response> {
  const accessError = cloudflareAccessError(result, requestUrl);
  if (accessError) throw accessError;
  return responseFromWire(result, signal);
}

export function sourceAccessFallbackUrl(
  url: string,
  init: PluginHttpInit,
): string {
  return init.sourceAccessUrl ?? init.contextUrl ?? url;
}
