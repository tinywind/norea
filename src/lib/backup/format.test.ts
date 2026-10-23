import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  BackupFormatError,
  encodeBackupManifest,
  parseBackupManifest,
  type BackupManifest,
} from "./format";

const VALID_MANIFEST: BackupManifest = {
  version: BACKUP_FORMAT_VERSION,
  exportedAt: 1_700_000_000,
  novels: [
    {
      id: 1,
      pluginId: "demo",
      sourceNovelId: "1",
      path: "/n/1",
      name: "Sample Novel",
      cover: null,
      summary: null,
      author: null,
      artist: null,
      status: null,
      genres: null,
      inLibrary: true,
      isLocal: false,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      libraryAddedAt: 1_700_000_000,
      lastReadAt: null,
    },
  ],
  chapters: [
    {
      id: 10,
      novelId: 1,
      path: "/c/1",
      name: "Chapter 1",
      chapterNumber: "1",
      position: 1,
      page: "1",
      bookmark: false,
      unread: true,
      progress: 0,
      isDownloaded: false,
      contentType: "html",
      sourceContentType: "text",
      content: null,
      contentBytes: 0,
      mediaBytes: 0,
      releaseTime: null,
      readAt: null,
      createdAt: 1_700_000_000,
      foundAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
    },
  ],
  categories: [{ id: 1, name: "Default", sort: 0, isSystem: true }],
  novelCategories: [{ id: 1, novelId: 1, categoryId: 1 }],
  repositories: [
    {
      id: 1,
      url: "https://example.test/p.json",
      name: "Example",
      addedAt: 1_700_000_000,
    },
  ],
  installedPlugins: [
    {
      id: "demo",
      name: "Demo",
      lang: "en",
      version: "1.0.0",
      iconUrl: "https://example.test/icon.png",
      sourceUrl: "https://example.test/index.js",
      sourceCode: "module.exports.default = {};",
      installedAt: 1_700_000_000,
    },
  ],
  settings: [
    {
      key: "reader-settings",
      value: JSON.stringify({ state: { general: {} }, version: 0 }),
    },
  ],
  vpnGateServerVerdicts: [
    {
      ip: "198.51.100.10",
      verdict: "works",
      updatedAt: 1_700_000_000,
    },
    {
      ip: "203.0.113.20",
      verdict: "fails",
      updatedAt: 1_700_000_001,
    },
  ],
};

describe("encodeBackupManifest + parseBackupManifest", () => {
  it("round-trips a valid manifest losslessly", () => {
    const json = encodeBackupManifest(VALID_MANIFEST);
    const parsed = parseBackupManifest(json);
    expect(parsed).toEqual(VALID_MANIFEST);
  });

  it("preserves unknown creation times for recovered chapters", () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      chapters: [{ ...VALID_MANIFEST.chapters[0]!, createdAt: null, foundAt: 0 }],
    };

    expect(parseBackupManifest(encodeBackupManifest(manifest))).toEqual(manifest);
  });

  it.each(["unknown", true, {}])("rejects an invalid chapter creation time %j", (createdAt) => {
    const manifest = {
      ...VALID_MANIFEST,
      chapters: [{ ...VALID_MANIFEST.chapters[0]!, createdAt }],
    };

    expect(() => parseBackupManifest(JSON.stringify(manifest))).toThrow(
      /chapters contains a malformed entry/,
    );
  });

  it("rejects inline chapter bodies from earlier development builds", () => {
    const manifest = {
      ...VALID_MANIFEST,
      chapters: [
        { ...VALID_MANIFEST.chapters[0]!, content: "<p>hi</p>" },
      ],
    };
    expect(() => parseBackupManifest(JSON.stringify(manifest))).toThrow(
      /chapters contains a malformed entry/,
    );
  });

  it("preserves chapter content byte counts in the round trip", () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      chapters: [
        {
          ...VALID_MANIFEST.chapters[0]!,
          isDownloaded: true,
          contentBytes: 4096,
        },
      ],
    };
    const round = parseBackupManifest(encodeBackupManifest(manifest));
    expect(round.chapters[0]?.contentBytes).toBe(4096);
  });

  it("rejects obsolete physical chapter content types", () => {
    const manifest = {
      ...VALID_MANIFEST,
      chapters: [{ ...VALID_MANIFEST.chapters[0]!, contentType: "markdown" }],
    };
    expect(() => parseBackupManifest(JSON.stringify(manifest))).toThrow(
      /chapters contains a malformed entry/,
    );
  });

  it("preserves epub chapter content type in the round trip", () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      chapters: [
        {
          ...VALID_MANIFEST.chapters[0]!,
          contentType: "epub",
        },
      ],
    };

    const round = parseBackupManifest(encodeBackupManifest(manifest));

    expect(round.chapters[0]?.contentType).toBe("epub");
  });

  it.each(["createdAt", "foundAt", "contentType", "sourceContentType", "contentBytes", "mediaBytes"])(
    "rejects chapter metadata missing %s",
    (field) => {
      const chapter: Record<string, unknown> = { ...VALID_MANIFEST.chapters[0]! };
      delete chapter[field];
      expect(() => parseBackupManifest(JSON.stringify({
        ...VALID_MANIFEST,
        chapters: [chapter],
      }))).toThrow(/chapters contains a malformed entry/);
    },
  );

  it.each(["installedPlugins", "settings", "vpnGateServerVerdicts"])(
    "rejects a manifest missing %s",
    (field) => {
      const manifest: Record<string, unknown> = { ...VALID_MANIFEST };
      delete manifest[field];
      expect(() => parseBackupManifest(JSON.stringify(manifest))).toThrow(
        `${field} is not an array`,
      );
    },
  );

  it("allows absent nullable library timestamps without inventing values", () => {
    const novel: Record<string, unknown> = { ...VALID_MANIFEST.novels[0]! };
    delete novel.libraryAddedAt;
    delete novel.lastReadAt;
    const parsed = parseBackupManifest(JSON.stringify({
      ...VALID_MANIFEST,
      novels: [novel],
    }));
    expect(parsed.novels[0]?.libraryAddedAt).toBeNull();
    expect(parsed.novels[0]?.lastReadAt).toBeNull();
  });

});

describe("parseBackupManifest error cases", () => {
  it("throws on invalid JSON", () => {
    expect(() => parseBackupManifest("not json")).toThrow(
      BackupFormatError,
    );
  });

  it("throws on a non-object root", () => {
    expect(() => parseBackupManifest("[]")).toThrow(BackupFormatError);
  });

  it("rejects version 1 manifests written by earlier builds", () => {
    const legacy = JSON.stringify({ ...VALID_MANIFEST, version: 1 });
    expect(() => parseBackupManifest(legacy)).toThrow(/version 1/);
  });

  it("throws on a wrong version", () => {
    const wrong = JSON.stringify({ ...VALID_MANIFEST, version: 99 });
    expect(() => parseBackupManifest(wrong)).toThrow(/version 99/);
  });

  it("throws on a missing exportedAt", () => {
    const broken = { ...VALID_MANIFEST, exportedAt: undefined };
    expect(() => parseBackupManifest(JSON.stringify(broken))).toThrow(
      /exportedAt/,
    );
  });

  it("throws on a non-array novels field", () => {
    const broken = { ...VALID_MANIFEST, novels: { wrong: true } };
    expect(() => parseBackupManifest(JSON.stringify(broken))).toThrow(
      /novels is not an array/,
    );
  });

  it("throws on a malformed novel row", () => {
    const broken = {
      ...VALID_MANIFEST,
      novels: [{ id: "not a number" }],
    };
    expect(() => parseBackupManifest(JSON.stringify(broken))).toThrow(
      /novels contains a malformed entry/,
    );
  });

  it("throws on a malformed chapter row", () => {
    const broken = {
      ...VALID_MANIFEST,
      chapters: [{ id: 1, novelId: 1 }],
    };
    expect(() => parseBackupManifest(JSON.stringify(broken))).toThrow(
      /chapters contains a malformed entry/,
    );
  });

  it("rejects backups with multiple configured repositories", () => {
    const manifest = {
      ...VALID_MANIFEST,
      repositories: [
        VALID_MANIFEST.repositories[0],
        { ...VALID_MANIFEST.repositories[0], id: 2 },
      ],
    };
    expect(() => parseBackupManifest(JSON.stringify(manifest))).toThrow(
      /at most one repository/,
    );
  });

  it("throws on a non-numeric chapter contentBytes", () => {
    const json = encodeBackupManifest({
      ...VALID_MANIFEST,
      chapters: [
        {
          ...VALID_MANIFEST.chapters[0]!,
          contentBytes: "4096" as unknown as number,
        },
      ],
    });
    expect(() => parseBackupManifest(json)).toThrow(BackupFormatError);
  });

  it("throws on a malformed VPN Gate server verdict row", () => {
    const broken = {
      ...VALID_MANIFEST,
      vpnGateServerVerdicts: [
        {
          ip: "198.51.100.10",
          verdict: "unknown",
          updatedAt: 1_700_000_000,
        },
      ],
    };

    expect(() => parseBackupManifest(JSON.stringify(broken))).toThrow(
      /vpnGateServerVerdicts contains a malformed entry/,
    );
  });

  it("throws on a VPN Gate server verdict with a non-canonical IPv4 address", () => {
    const broken = {
      ...VALID_MANIFEST,
      vpnGateServerVerdicts: [
        {
          ip: "198.051.100.10",
          verdict: "works",
          updatedAt: 1_700_000_000,
        },
      ],
    };

    expect(() => parseBackupManifest(JSON.stringify(broken))).toThrow(
      /vpnGateServerVerdicts contains a malformed entry/,
    );
  });
});
