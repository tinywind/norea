import type {
  SourceAccessChallenge,
  SourceAccessChallengeKind,
} from "./types";

export type { SourceAccessChallenge, SourceAccessChallengeKind } from "./types";

export interface SourceAccessRequiredErrorShape extends Error {
  challenge: SourceAccessChallenge;
  code: "source-access-required";
}

export class SourceAccessRequiredError
  extends Error
  implements SourceAccessRequiredErrorShape
{
  readonly challenge: SourceAccessChallenge;
  readonly code = "source-access-required" as const;

  constructor(message: string, challenge: SourceAccessChallenge) {
    super(message);
    this.name = "SourceAccessRequiredError";
    this.challenge = challenge;
  }
}

function isChallengeKind(value: unknown): value is SourceAccessChallengeKind {
  return value === "captcha" || value === "cloudflare";
}

function safeHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function normalizeHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function challengeFromEnvelope(
  envelope: Record<string, unknown>,
  fallbackUrl: string,
): SourceAccessChallenge | null {
  if (envelope.code !== "manual-action-required") return null;
  if (envelope.challenge === null || typeof envelope.challenge !== "object") {
    return null;
  }
  const challenge = envelope.challenge as Record<string, unknown>;
  if (!isChallengeKind(challenge.kind)) return null;

  const fallback = safeHttpUrl(fallbackUrl);
  if (!fallback) return null;
  const candidate = safeHttpUrl(challenge.url);
  const url =
    candidate && normalizeHostname(candidate) === normalizeHostname(fallback)
      ? candidate
      : fallback;
  return { kind: challenge.kind, url: url.href };
}

export function sourceAccessErrorFromEnvelope(
  envelope: Record<string, unknown>,
  fallbackUrl: string,
): Error {
  const code =
    typeof envelope.code === "string" ? envelope.code : "capture-failed";
  const message =
    typeof envelope.error === "string"
      ? envelope.error
      : "Chapter page capture failed.";
  const challenge = challengeFromEnvelope(envelope, fallbackUrl);
  if (challenge) return new SourceAccessRequiredError(message, challenge);
  return new Error(`${code}: ${message}`);
}

export function isSourceAccessRequiredError(
  value: unknown,
): value is SourceAccessRequiredErrorShape {
  if (value === null || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  if (
    error.code !== "source-access-required" ||
    error.challenge === null ||
    typeof error.challenge !== "object"
  ) {
    return false;
  }
  const challenge = error.challenge as Record<string, unknown>;
  return (
    isChallengeKind(challenge.kind) && safeHttpUrl(challenge.url) !== null
  );
}

export function normalizeSourceAccessRequiredError(
  value: unknown,
  fallbackUrl?: string,
): SourceAccessRequiredErrorShape | null {
  if (value === null || typeof value !== "object") return null;
  const error = value as Record<string, unknown>;
  if (isSourceAccessRequiredError(value) && !fallbackUrl) return value;
  if (
    error.code !== "manual-action-required" &&
    error.code !== "source-access-required"
  ) {
    return null;
  }
  const challenge =
    error.challenge !== null && typeof error.challenge === "object"
      ? (error.challenge as Record<string, unknown>)
      : null;
  const trustedFallback = fallbackUrl ??
    (typeof challenge?.url === "string" ? challenge.url : undefined);
  if (!trustedFallback) return null;
  const normalized = sourceAccessErrorFromEnvelope(
    {
      code: "manual-action-required",
      error:
        typeof error.message === "string"
          ? error.message
          : "The source page requires manual action.",
      challenge,
    },
    trustedFallback,
  );
  return isSourceAccessRequiredError(normalized) ? normalized : null;
}

export function sourceAccessScopeKey(url: string): string {
  const parsed = safeHttpUrl(url);
  if (!parsed) throw new Error("Source access URL must be an absolute HTTP URL.");
  return `site:${normalizeHostname(parsed)}`;
}
