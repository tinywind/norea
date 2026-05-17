import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  MAX_NATIVE_STREAM_CHUNK_BYTES,
  NativeStreamError,
  type NativeStreamInfo,
  createNativeStream,
  readNativeStreamChunk,
  writeNativeStream,
  writeNativeStreamChunk,
} from "./native-stream";

const invokeMock = vi.mocked(invoke);

function streamInfo(size: number): NativeStreamInfo {
  return {
    createdAtMs: 1,
    domain: "backup",
    expiresAtMs: 2,
    finished: false,
    handle: "stream-1",
    maxBytes: 100,
    size,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("native stream facade", () => {
  it("creates a stream with normalized options", async () => {
    invokeMock.mockResolvedValue(streamInfo(0));

    await expect(
      createNativeStream({
        domain: " backup ",
        maxBytes: 100,
        ttlMs: 1_000,
      }),
    ).resolves.toEqual(streamInfo(0));

    expect(invokeMock).toHaveBeenCalledWith("native_stream_create", {
      domain: "backup",
      maxBytes: 100,
      ttlMs: 1_000,
    });
  });

  it("splits writes into bounded ordered chunks", async () => {
    const writeResults = [streamInfo(3), streamInfo(6), streamInfo(8)];
    invokeMock.mockImplementation(async (command) => {
      if (command !== "native_stream_write_chunk") {
        throw new Error(`unexpected command: ${command}`);
      }
      return writeResults.shift();
    });

    const result = await writeNativeStream(
      "stream-1",
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      { chunkBytes: 3 },
    );

    expect(result.size).toBe(8);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "native_stream_write_chunk", {
      chunk: [1, 2, 3],
      handle: "stream-1",
      offset: 0,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "native_stream_write_chunk", {
      chunk: [4, 5, 6],
      handle: "stream-1",
      offset: 3,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "native_stream_write_chunk", {
      chunk: [7, 8],
      handle: "stream-1",
      offset: 6,
    });
  });

  it("cancels native state when an abort is observed between chunks", async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (command) => {
      if (command === "native_stream_write_chunk") {
        controller.abort();
        return streamInfo(2);
      }
      if (command === "native_stream_cancel") {
        return undefined;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      writeNativeStream("stream-1", new Uint8Array([1, 2, 3, 4]), {
        chunkBytes: 2,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "aborted",
    });

    expect(invokeMock).toHaveBeenCalledWith("native_stream_cancel", {
      handle: "stream-1",
    });
  });

  it("maps native quota failures to typed errors", async () => {
    invokeMock.mockRejectedValue(
      "native stream: quota exceeded; 4 bytes exceeds the 3 byte budget",
    );

    await expect(
      writeNativeStreamChunk("stream-1", [1, 2], { offset: 2 }),
    ).rejects.toMatchObject({
      code: "quota-exceeded",
    });
  });

  it("rejects chunks above the facade chunk limit before invoking native code", async () => {
    await expect(
      writeNativeStreamChunk(
        "stream-1",
        new Uint8Array(MAX_NATIVE_STREAM_CHUNK_BYTES + 1),
      ),
    ).rejects.toBeInstanceOf(NativeStreamError);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads native chunks as Uint8Array values", async () => {
    invokeMock.mockResolvedValue({
      bytes: [2, 3, 4],
      eof: true,
      offset: 1,
    });

    const chunk = await readNativeStreamChunk("stream-1", 1, 3);

    expect(chunk.offset).toBe(1);
    expect(chunk.eof).toBe(true);
    expect([...chunk.bytes]).toEqual([2, 3, 4]);
    expect(invokeMock).toHaveBeenCalledWith("native_stream_read_chunk", {
      handle: "stream-1",
      length: 3,
      offset: 1,
    });
  });
});
