import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./http", () => ({
  appFetch: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { appFetch } from "./http";
import {
  MAX_INLINE_IPC_BYTES,
  MAX_UPDATE_BYTES,
} from "./performance-budgets";
import {
  type BuildInfo,
  type UpdateCandidate,
  type UpdateAssetIntegrity,
  type UpdateManifest,
  checkDevUpdate,
  checkOfficialUpdate,
  installUpdate,
  validateDevUpdateManifestBinding,
  validateInlineUpdateIpcByteLength,
  validateUpdateDownloadByteLength,
  verifyDownloadedUpdateBytes,
} from "./update";
import { buildSyntheticArrayBuffer } from "../test/fixtures/performance";

const SHA256_010203 =
  "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const GITHUB_API_BASE = "https://api.github.com/repos/tinywind/norea";

const VALID_INTEGRITY: UpdateAssetIntegrity = {
  sha256: SHA256_010203,
  signature: null,
  signingKeyId: null,
  size: 3,
};

const invokeMock = vi.mocked(invoke);
const appFetchMock = vi.mocked(appFetch);

const ANDROID_BUILD_INFO: BuildInfo = {
  buildChannel: null,
  buildTime: null,
  buildVersion: "0.1.0",
  gitSha: null,
  githubRunAttempt: null,
  githubRunId: null,
  platform: "android-arm64",
  targetArch: "aarch64",
  targetFamily: "unix",
  targetOs: "android",
};

const LINUX_BUILD_INFO: BuildInfo = {
  buildChannel: "dev",
  buildTime: "2026-05-01T00:00:00Z",
  buildVersion: "1.0.0",
  gitSha: "local-sha",
  githubRunAttempt: "1",
  githubRunId: "100",
  platform: "linux-x64",
  targetArch: "x86_64",
  targetFamily: "unix",
  targetOs: "linux",
};

function updateCandidate(
  integrity: UpdateAssetIntegrity = VALID_INTEGRITY,
): UpdateCandidate {
  return {
    assetName: "norea-arm64.apk",
    channel: "official",
    displayName: "Norea",
    downloadFileName: "norea-arm64.apk",
    downloadSize: integrity.size,
    downloadUrl: "https://github.com/tinywind/norea/releases/download/v0.1.1/norea-arm64.apk",
    integrity,
    remoteTime: "2026-05-17T00:00:00Z",
    remoteVersion: "0.1.1",
    sourceUrl: "https://github.com/tinywind/norea/releases/tag/v0.1.1",
    status: "newer",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status,
  });
}

function mockJsonRoutes(routes: Record<string, unknown>): void {
  appFetchMock.mockImplementation(async (url) => {
    const route = routes[String(url)];
    if (route === undefined) {
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }
    return jsonResponse(route);
  });
}

function officialRelease(
  assets: Array<{ browser_download_url: string; name: string; size?: number }>,
) {
  return {
    assets,
    html_url: "https://github.com/tinywind/norea/releases/tag/v1.2.0",
    name: "v1.2.0",
    published_at: "2026-05-10T00:00:00Z",
    tag_name: "v1.2.0",
  };
}

function stableManifest(overrides: Record<string, unknown> = {}) {
  return {
    assets: [
      {
        artifactName: "norea-linux-x64.AppImage",
        name: "norea-linux-x64.AppImage",
        platform: "linux-x64",
        ...VALID_INTEGRITY,
      },
    ],
    channel: "stable",
    dev: null,
    generatedAt: "2026-05-10T00:00:00Z",
    platform: "linux-x64",
    schemaVersion: 1,
    signature: null,
    signingKeyId: null,
    version: "1.2.0",
    ...overrides,
  };
}

function mockDevUpdateRoutes(
  devOverrides: Record<string, unknown> = {},
): void {
  const manifestUrl =
    "https://github.com/tinywind/norea/releases/download/dev/norea-updates-linux-x64.json";
  mockJsonRoutes({
    [`${GITHUB_API_BASE}/actions/workflows/linux.yml/runs?status=success&per_page=10`]:
      {
        workflow_runs: [
          {
            conclusion: "success",
            created_at: "2026-05-11T00:00:00Z",
            head_sha: "remote-head-sha",
            html_url: "https://github.com/tinywind/norea/actions/runs/123",
            id: 123,
            run_attempt: 2,
            status: "completed",
            updated_at: "2026-05-11T00:10:00Z",
          },
        ],
      },
    [`${GITHUB_API_BASE}/actions/runs/123/artifacts?per_page=100`]: {
      artifacts: [
        {
          expired: false,
          name: "norea-linux-x64.AppImage",
          size_in_bytes: VALID_INTEGRITY.size,
        },
      ],
    },
    [`${GITHUB_API_BASE}/releases/tags/dev`]: {
      assets: [
        {
          browser_download_url:
            "https://github.com/tinywind/norea/releases/download/dev/norea-linux-x64.AppImage",
          name: "norea-linux-x64.AppImage",
          size: VALID_INTEGRITY.size,
        },
        {
          browser_download_url: manifestUrl,
          name: "norea-updates-linux-x64.json",
          size: 300,
        },
      ],
      html_url: "https://github.com/tinywind/norea/releases/tag/dev",
      name: "Latest dev build",
      published_at: "2026-05-11T00:10:00Z",
      tag_name: "dev",
    },
    [manifestUrl]: {
      assets: [
        {
          artifactName: "norea-linux-x64.AppImage",
          name: "norea-linux-x64.AppImage",
          platform: "linux-x64",
          ...VALID_INTEGRITY,
        },
      ],
      channel: "dev",
      dev: {
        artifactName: null,
        headSha: "remote-head-sha",
        runAttempt: "2",
        runId: "123",
        workflow: "linux.yml",
        ...devOverrides,
      },
      generatedAt: "2026-05-11T00:10:00Z",
      platform: "linux-x64",
      schemaVersion: 1,
      signature: null,
      signingKeyId: null,
      version: null,
    },
  });
}

function installAndroidBridge(
  openApk = vi.fn(() => JSON.stringify({ ok: true })),
) {
  vi.stubGlobal("window", {
    __NoreaAndroidBridge: {
      nonce: vi.fn(() => "nonce-123"),
      session: vi.fn(() =>
        JSON.stringify({
          capabilities: ["update.openApk"],
          sessionToken: "session-token",
          version: 2,
        }),
      ),
    },
    __NoreaAndroidUpdater: {
      openApk,
    },
  });
  return openApk;
}

function streamInfo(size: number, finished = false) {
  return {
    createdAtMs: 1,
    domain: "update",
    expiresAtMs: 2,
    finished,
    handle: "update-stream-1",
    maxBytes: MAX_UPDATE_BYTES,
    size,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  appFetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("update byte budgets", () => {
  it("accepts update downloads at the configured maximum", () => {
    expect(() =>
      validateUpdateDownloadByteLength(MAX_UPDATE_BYTES),
    ).not.toThrow();
  });

  it("rejects update downloads above the configured maximum", () => {
    expect(() =>
      validateUpdateDownloadByteLength(MAX_UPDATE_BYTES + 1),
    ).toThrow(/Update download.*exceeds/);
  });

  it("rejects inline update IPC payloads above the configured maximum", () => {
    expect(() =>
      validateInlineUpdateIpcByteLength(MAX_INLINE_IPC_BYTES + 1),
    ).toThrow(/Update IPC payload.*exceeds/);
  });

  it("accepts ordinary inline payload sizes from synthetic fixtures", () => {
    const payload = buildSyntheticArrayBuffer(32);

    expect(() =>
      validateInlineUpdateIpcByteLength(payload.byteLength),
    ).not.toThrow();
  });
});

describe("update integrity metadata", () => {
  it("accepts payloads matching the metadata size and digest", async () => {
    await expect(
      verifyDownloadedUpdateBytes(new Uint8Array([1, 2, 3]), VALID_INTEGRITY),
    ).resolves.toBeUndefined();
  });

  it("rejects payloads with a mismatched size", async () => {
    await expect(
      verifyDownloadedUpdateBytes(new Uint8Array([1, 2, 3]), {
        ...VALID_INTEGRITY,
        size: 2,
      }),
    ).rejects.toThrow(/size does not match metadata/);
  });

  it("rejects payloads with a mismatched digest", async () => {
    await expect(
      verifyDownloadedUpdateBytes(new Uint8Array([1, 2, 3]), {
        ...VALID_INTEGRITY,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/SHA-256 does not match metadata/);
  });

  it("selects manifest metadata for stable update candidates", async () => {
    const manifestUrl =
      "https://github.com/tinywind/norea/releases/download/v1.2.0/norea-updates-linux-x64.json";
    mockJsonRoutes({
      [`${GITHUB_API_BASE}/releases/latest`]: officialRelease([
        {
          browser_download_url:
            "https://github.com/tinywind/norea/releases/download/v1.2.0/norea-linux-x64.AppImage",
          name: "norea-linux-x64.AppImage",
          size: VALID_INTEGRITY.size,
        },
        {
          browser_download_url: manifestUrl,
          name: "norea-updates-linux-x64.json",
          size: 300,
        },
      ]),
      [manifestUrl]: stableManifest(),
    });

    const candidate = await checkOfficialUpdate(LINUX_BUILD_INFO);

    expect(candidate.integrity).toEqual(VALID_INTEGRITY);
    expect(candidate.downloadSize).toBe(VALID_INTEGRITY.size);
    expect(candidate.status).toBe("newer");
  });

  it("rejects stable manifest platform mismatches", async () => {
    const manifestUrl =
      "https://github.com/tinywind/norea/releases/download/v1.2.0/norea-updates-linux-x64.json";
    mockJsonRoutes({
      [`${GITHUB_API_BASE}/releases/latest`]: officialRelease([
        {
          browser_download_url:
            "https://github.com/tinywind/norea/releases/download/v1.2.0/norea-linux-x64.AppImage",
          name: "norea-linux-x64.AppImage",
          size: VALID_INTEGRITY.size,
        },
        {
          browser_download_url: manifestUrl,
          name: "norea-updates-linux-x64.json",
          size: 300,
        },
      ]),
      [manifestUrl]: stableManifest({ platform: "windows-x64" }),
    });

    await expect(checkOfficialUpdate(LINUX_BUILD_INFO)).rejects.toThrow(
      /platform windows-x64 does not match linux-x64/,
    );
  });

  it("rejects stable release detection when metadata is absent", async () => {
    mockJsonRoutes({
      [`${GITHUB_API_BASE}/releases/latest`]: officialRelease([
        {
          browser_download_url:
            "https://github.com/tinywind/norea/releases/download/v1.2.0/norea-linux-x64.AppImage",
          name: "norea-linux-x64.AppImage",
          size: VALID_INTEGRITY.size,
        },
      ]),
    });

    await expect(checkOfficialUpdate(LINUX_BUILD_INFO)).rejects.toThrow(
      /No update metadata asset named norea-updates-linux-x64\.json/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("dev update provenance", () => {
  const manifest: UpdateManifest = {
    assets: [
      {
        artifactName: "norea-x64.exe",
        name: "norea-x64.exe",
        platform: "windows-x64",
        ...VALID_INTEGRITY,
      },
    ],
    channel: "dev",
    dev: {
      artifactName: "norea-x64.exe",
      headSha: "abc123",
      runAttempt: "2",
      runId: "12345",
      workflow: "windows.yml",
    },
    generatedAt: "2026-05-17T00:00:00Z",
    platform: "windows-x64",
    schemaVersion: 1,
    signature: null,
    signingKeyId: null,
    version: null,
  };

  it("accepts metadata bound to the selected workflow run", () => {
    expect(() =>
      validateDevUpdateManifestBinding(manifest, {
        artifactName: null,
        headSha: "abc123",
        runAttempt: "2",
        runId: "12345",
        workflow: "windows.yml",
      }),
    ).not.toThrow();
  });

  it("rejects metadata from a different workflow attempt", () => {
    expect(() =>
      validateDevUpdateManifestBinding(manifest, {
        artifactName: null,
        headSha: "abc123",
        runAttempt: "1",
        runId: "12345",
        workflow: "windows.yml",
      }),
    ).toThrow(/runAttempt/);
  });

  it("accepts dev metadata bound to the selected workflow run", async () => {
    mockDevUpdateRoutes();

    const candidate = await checkDevUpdate(LINUX_BUILD_INFO);

    expect(candidate.devRun).toEqual({
      artifactName: null,
      headSha: "remote-head-sha",
      runAttempt: "2",
      runId: "123",
      workflow: "linux.yml",
    });
    expect(candidate.integrity).toEqual(VALID_INTEGRITY);
  });

  it.each([
    ["run id", { runId: "124" }, /runId does not match/],
    ["run attempt", { runAttempt: "3" }, /runAttempt does not match/],
    ["head SHA", { headSha: "other-head-sha" }, /headSha does not match/],
  ])("rejects dev metadata with the wrong %s", async (_label, override, error) => {
    mockDevUpdateRoutes(override);

    await expect(checkDevUpdate(LINUX_BUILD_INFO)).rejects.toThrow(error);
  });
});

describe("update installation", () => {
  it("delegates desktop installation to the native verified download path", async () => {
    const installerPath =
      "/home/user/Downloads/Norea Updates/norea-linux-x64.AppImage";
    const candidate = updateCandidate();
    invokeMock.mockResolvedValue(installerPath);

    await expect(installUpdate(candidate, LINUX_BUILD_INFO)).resolves.toBe(
      installerPath,
    );

    expect(invokeMock).toHaveBeenCalledWith("download_and_open_update", {
      fileName: candidate.downloadFileName,
      metadata: candidate.integrity,
      url: candidate.downloadUrl,
    });
    expect(appFetchMock).not.toHaveBeenCalled();
  });

  it("keeps the renderer stream fallback when native Android download support is unavailable", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const candidate = updateCandidate({
      ...VALID_INTEGRITY,
      size: bytes.byteLength,
    });
    const installerPath =
      "/data/user/0/io.github.tinywind.norea/cache/Norea Updates/norea-arm64.apk";
    const openApk = installAndroidBridge();
    appFetchMock.mockResolvedValue({
      arrayBuffer: async () => bytes.buffer,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length"
            ? String(bytes.byteLength)
            : null,
      },
      ok: true,
      status: 200,
    } as Response);
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "download_and_open_update") {
        throw new Error("unknown command: download_and_open_update");
      }
      if (command === "native_stream_create") return streamInfo(0);
      if (command === "native_stream_write_chunk") {
        const chunk = (args as unknown as { chunk: number[] }).chunk;
        return streamInfo(chunk.length);
      }
      if (command === "native_stream_finish") {
        return streamInfo(bytes.byteLength, true);
      }
      if (command === "open_downloaded_update_handle") {
        expect(args).toMatchObject({
          fileName: candidate.downloadFileName,
          handle: "update-stream-1",
          metadata: candidate.integrity,
        });
        return installerPath;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(installUpdate(candidate, ANDROID_BUILD_INFO)).resolves.toBe(
      installerPath,
    );

    expect(appFetchMock).toHaveBeenCalledWith(candidate.downloadUrl, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "Norea",
      },
    });
    expect(openApk).toHaveBeenCalledTimes(1);
  });
});
