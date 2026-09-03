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

  it("preserves chapter content in the round trip", () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      chapters: [
        { ...VALID_MANIFEST.chapters[0]!, content: "<p>hi</p>" },
      ],
    };
    const round = parseBackupManifest(encodeBackupManifest(manifest));
    expect(round.chapters[0]?.content).toBe("<p>hi</p>");
  });

  it("normalizes markdown chapter content type to html in the round trip", () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      chapters: [
        {
          ...VALID_MANIFEST.chapters[0]!,
          contentType: "markdown",
          content: `<section class="reader-markdown-content"><h1>Hi</h1></section>`,
        },
      ],
    };

    const round = parseBackupManifest(encodeBackupManifest(manifest));

    expect(round.chapters[0]?.contentType).toBe("html");
    expect(round.chapters[0]?.content).toContain("reader-markdown-content");
  });

  it("preserves epub chapter content type in the round trip", () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      chapters: [
        {
          ...VALID_MANIFEST.chapters[0]!,
          contentType: "epub",
          content: `<article class="reader-epub-content" data-epub-rendered="true"><section>Hi</section></article>`,
        },
      ],
    };

    const round = parseBackupManifest(encodeBackupManifest(manifest));

    expect(round.chapters[0]?.contentType).toBe("epub");
    expect(round.chapters[0]?.content).toContain("reader-epub-content");
  });

  it("preserves source and physical chapter content types separately", () => {
    const round = parseBackupManifest(encodeBackupManifest(VALID_MANIFEST));

    expect(round.chapters[0]?.sourceContentType).toBe("text");
    expect(round.chapters[0]?.contentType).toBe("html");
  });

  it("normalizes older v1 manifests that lack discovery timestamps", () => {
    const legacy = JSON.parse(
      encodeBackupManifest(VALID_MANIFEST),
    ) as Record<string, unknown>;
    const novels = legacy.novels as Array<Record<string, unknown>>;
    const chapters = legacy.chapters as Array<Record<string, unknown>>;
    delete novels[0]!.libraryAddedAt;
    delete legacy.installedPlugins;
    delete legacy.settings;
    delete legacy.vpnGateServerVerdicts;
    delete chapters[0]!.createdAt;
    delete chapters[0]!.contentType;
    delete chapters[0]!.sourceContentType;
    delete chapters[0]!.foundAt;

    const parsed = parseBackupManifest(JSON.stringify(legacy));

    expect(parsed.novels[0]?.libraryAddedAt).toBeNull();
    expect(parsed.chapters[0]?.createdAt).toBe(
      VALID_MANIFEST.chapters[0]?.updatedAt,
    );
    expect(parsed.chapters[0]?.contentType).toBe("html");
    expect(parsed.chapters[0]?.sourceContentType).toBe("html");
    expect(parsed.chapters[0]?.foundAt).toBe(
      VALID_MANIFEST.chapters[0]?.updatedAt,
    );
    expect(parsed.installedPlugins).toBeUndefined();
    expect(parsed.settings).toBeUndefined();
    expect(parsed.vpnGateServerVerdicts).toBeUndefined();
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
