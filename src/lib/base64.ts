import { requestAbortedError } from "./abort";
import { yieldToEventLoop } from "./event-loop";

export type Base64ByteSource = Uint8Array | readonly number[];

// Bytes handed to one String.fromCharCode spread call.
const SYNC_ENCODE_CHUNK_SIZE = 0x8000;
// A multiple of 3 so every btoa chunk ends on a padding-free boundary.
const COOPERATIVE_ENCODE_CHUNK_SIZE = 0x6000;
// A multiple of 4 so every atob chunk is a complete base64 group.
const COOPERATIVE_DECODE_CHUNK_SIZE = 0x8000;
const EVENT_LOOP_YIELD_INTERVAL = 16;

function byteView(bytes: Base64ByteSource): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}

export function bytesToBase64(bytes: Base64ByteSource): string {
  const view = byteView(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += SYNC_ENCODE_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...view.subarray(offset, offset + SYNC_ENCODE_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function bytesToBase64Cooperatively(
  bytes: Base64ByteSource,
): Promise<string> {
  const view = byteView(bytes);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < view.length;
    offset += COOPERATIVE_ENCODE_CHUNK_SIZE
  ) {
    chunks.push(
      btoa(
        String.fromCharCode(
          ...view.subarray(offset, offset + COOPERATIVE_ENCODE_CHUNK_SIZE),
        ),
      ),
    );
    if (
      chunks.length % EVENT_LOOP_YIELD_INTERVAL === 0 &&
      offset + COOPERATIVE_ENCODE_CHUNK_SIZE < view.length
    ) {
      await yieldToEventLoop();
    }
  }
  return chunks.join("");
}

export async function base64ToByteChunksCooperatively(
  base64: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (
    let offset = 0;
    offset < base64.length;
    offset += COOPERATIVE_DECODE_CHUNK_SIZE
  ) {
    if (signal?.aborted) throw requestAbortedError();
    chunks.push(
      base64ToBytes(base64.slice(offset, offset + COOPERATIVE_DECODE_CHUNK_SIZE)),
    );
    if (
      chunks.length % EVENT_LOOP_YIELD_INTERVAL === 0 &&
      offset + COOPERATIVE_DECODE_CHUNK_SIZE < base64.length
    ) {
      await yieldToEventLoop();
    }
  }
  return chunks;
}
