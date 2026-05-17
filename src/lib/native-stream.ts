import { invoke } from "@tauri-apps/api/core";
import { MAX_INLINE_IPC_BYTES } from "./performance-budgets";

const BYTES_PER_MIB = 1024 * 1024;

export const MAX_NATIVE_STREAM_BYTES = 2 * 1024 * BYTES_PER_MIB;
export const MAX_NATIVE_STREAM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_NATIVE_STREAM_CHUNK_BYTES = Math.min(
  4 * BYTES_PER_MIB,
  MAX_INLINE_IPC_BYTES,
);
export const DEFAULT_NATIVE_STREAM_CHUNK_BYTES = Math.min(
  BYTES_PER_MIB,
  MAX_NATIVE_STREAM_CHUNK_BYTES,
);

export type NativeStreamErrorCode =
  | "aborted"
  | "expired"
  | "invalid-handle"
  | "invalid-offset"
  | "invalid-options"
  | "native-error"
  | "quota-exceeded";

export class NativeStreamError extends Error {
  readonly cause: unknown;
  readonly code: NativeStreamErrorCode;

  constructor(
    code: NativeStreamErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "NativeStreamError";
    this.code = code;
    this.cause = cause;
  }
}

export interface NativeStreamInfo {
  createdAtMs: number;
  domain: string;
  expiresAtMs: number;
  finished: boolean;
  handle: string;
  maxBytes: number;
  size: number;
}

interface NativeStreamReadChunkWire {
  bytes: number[];
  eof: boolean;
  offset: number;
}

export interface NativeStreamReadChunk {
  bytes: Uint8Array;
  eof: boolean;
  offset: number;
}

export interface NativeStreamCleanupResult {
  expired: number;
  orphaned: number;
  removed: number;
}

export interface CreateNativeStreamOptions {
  domain: string;
  maxBytes?: number;
  ttlMs?: number;
}

export interface NativeStreamWriteOptions {
  chunkBytes?: number;
  signal?: AbortSignal;
  startOffset?: number;
}

type NativeStreamBytes = ArrayBuffer | ArrayBufferView | readonly number[];

export function isNativeStreamError(
  error: unknown,
): error is NativeStreamError {
  return error instanceof NativeStreamError;
}

export async function createNativeStream(
  options: CreateNativeStreamOptions,
): Promise<NativeStreamInfo> {
  const domain = normalizeDomain(options.domain);
  const maxBytes = normalizeOptionalPositiveInteger(
    options.maxBytes,
    "maxBytes",
    MAX_NATIVE_STREAM_BYTES,
  );
  const ttlMs = normalizeOptionalPositiveInteger(
    options.ttlMs,
    "ttlMs",
    MAX_NATIVE_STREAM_TTL_MS,
  );

  return invokeNative<NativeStreamInfo>("native_stream_create", {
    domain,
    maxBytes,
    ttlMs,
  });
}

export async function writeNativeStreamChunk(
  handle: string,
  chunk: NativeStreamBytes,
  options: { offset?: number } = {},
): Promise<NativeStreamInfo> {
  assertHandle(handle);
  const bytes = bytesToUint8Array(chunk);
  if (bytes.byteLength > MAX_NATIVE_STREAM_CHUNK_BYTES) {
    throw new NativeStreamError(
      "invalid-options",
      `Native stream chunk exceeds the ${MAX_NATIVE_STREAM_CHUNK_BYTES} byte facade limit.`,
    );
  }
  const offset = normalizeOptionalNonNegativeInteger(options.offset, "offset");

  return invokeNative<NativeStreamInfo>("native_stream_write_chunk", {
    chunk: Array.from(bytes),
    handle,
    offset,
  });
}

export async function writeNativeStream(
  handle: string,
  body: NativeStreamBytes,
  options: NativeStreamWriteOptions = {},
): Promise<NativeStreamInfo> {
  assertHandle(handle);
  const bytes = bytesToUint8Array(body);
  const chunkBytes = normalizeChunkBytes(options.chunkBytes);
  let offset = normalizeOptionalNonNegativeInteger(
    options.startOffset,
    "startOffset",
  ) ?? 0;
  let lastInfo: NativeStreamInfo | null = null;

  try {
    for (let index = 0; index < bytes.byteLength; index += chunkBytes) {
      throwIfAborted(options.signal);
      const end = Math.min(index + chunkBytes, bytes.byteLength);
      lastInfo = await writeNativeStreamChunk(
        handle,
        bytes.subarray(index, end),
        { offset },
      );
      offset = lastInfo.size;
    }
    throwIfAborted(options.signal);
  } catch (error) {
    const streamError = toNativeStreamError(error);
    if (streamError.code === "aborted") {
      try {
        await cancelNativeStream(handle);
      } catch {
        // The caller already receives the abort error; cleanup is best-effort.
      }
    }
    throw streamError;
  }

  return lastInfo ?? getNativeStreamInfo(handle);
}

export async function finishNativeStream(
  handle: string,
): Promise<NativeStreamInfo> {
  assertHandle(handle);
  return invokeNative<NativeStreamInfo>("native_stream_finish", { handle });
}

export async function getNativeStreamInfo(
  handle: string,
): Promise<NativeStreamInfo> {
  assertHandle(handle);
  return invokeNative<NativeStreamInfo>("native_stream_info", { handle });
}

export async function readNativeStreamChunk(
  handle: string,
  offset: number,
  length: number,
): Promise<NativeStreamReadChunk> {
  assertHandle(handle);
  const normalizedOffset = normalizeNonNegativeInteger(offset, "offset");
  const normalizedLength = normalizeNonNegativeInteger(length, "length");
  if (normalizedLength > MAX_NATIVE_STREAM_CHUNK_BYTES) {
    throw new NativeStreamError(
      "invalid-options",
      `Native stream read length exceeds the ${MAX_NATIVE_STREAM_CHUNK_BYTES} byte facade limit.`,
    );
  }

  const result = await invokeNative<NativeStreamReadChunkWire>(
    "native_stream_read_chunk",
    {
      handle,
      length: normalizedLength,
      offset: normalizedOffset,
    },
  );
  return {
    bytes: Uint8Array.from(result.bytes),
    eof: result.eof,
    offset: result.offset,
  };
}

export async function deleteNativeStream(handle: string): Promise<void> {
  assertHandle(handle);
  await invokeNative("native_stream_delete", { handle });
}

export async function cancelNativeStream(handle: string): Promise<void> {
  assertHandle(handle);
  await invokeNative("native_stream_cancel", { handle });
}

export async function cleanupNativeStreams(): Promise<NativeStreamCleanupResult> {
  return invokeNative<NativeStreamCleanupResult>("native_stream_cleanup");
}

async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toNativeStreamError(error);
  }
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    throw new NativeStreamError(
      "invalid-options",
      "Native stream domain must be 1-64 characters using letters, numbers, dot, underscore, dash, or colon.",
    );
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  label: string,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NativeStreamError(
      "invalid-options",
      `Native stream ${label} must be a positive integer.`,
    );
  }
  if (value > max) {
    throw new NativeStreamError(
      "invalid-options",
      `Native stream ${label} exceeds the ${max} limit.`,
    );
  }
  return value;
}

function normalizeOptionalNonNegativeInteger(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  return normalizeNonNegativeInteger(value, label);
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NativeStreamError(
      "invalid-options",
      `Native stream ${label} must be a non-negative integer.`,
    );
  }
  return value;
}

function normalizeChunkBytes(value: number | undefined): number {
  const chunkBytes = value ?? DEFAULT_NATIVE_STREAM_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new NativeStreamError(
      "invalid-options",
      "Native stream chunkBytes must be a positive integer.",
    );
  }
  if (chunkBytes > MAX_NATIVE_STREAM_CHUNK_BYTES) {
    throw new NativeStreamError(
      "invalid-options",
      `Native stream chunkBytes exceeds the ${MAX_NATIVE_STREAM_CHUNK_BYTES} byte facade limit.`,
    );
  }
  return chunkBytes;
}

function assertHandle(handle: string): void {
  if (handle.trim() === "") {
    throw new NativeStreamError(
      "invalid-handle",
      "Native stream handle is required.",
    );
  }
}

function bytesToUint8Array(bytes: NativeStreamBytes): Uint8Array {
  if (Array.isArray(bytes)) {
    validateByteNumbers(bytes);
    return Uint8Array.from(bytes);
  }
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

function validateByteNumbers(bytes: readonly number[]): void {
  for (const value of bytes) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new NativeStreamError(
        "invalid-options",
        "Native stream byte arrays must contain integers from 0 through 255.",
      );
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new NativeStreamError("aborted", "Native stream write was aborted.");
  }
}

function toNativeStreamError(error: unknown): NativeStreamError {
  if (error instanceof NativeStreamError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NativeStreamError(nativeErrorCode(message), message, error);
}

function nativeErrorCode(message: string): NativeStreamErrorCode {
  if (/abort/i.test(message)) return "aborted";
  if (/expired/i.test(message)) return "expired";
  if (/invalid handle/i.test(message)) return "invalid-handle";
  if (/offset/i.test(message)) return "invalid-offset";
  if (/quota|budget/i.test(message)) return "quota-exceeded";
  if (/domain|maxBytes|ttlMs|chunk|length|limit|invalid/i.test(message)) {
    return "invalid-options";
  }
  return "native-error";
}
