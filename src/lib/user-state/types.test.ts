import { describe, expect, it } from "vitest";
import {
  canonicalUserStateJson, parsePortableReaderAnchor, parseUserStateEntity, parseUserStateMergeResponse,
  parseUserStateOperation, parseUserStateReadResponse, parseUserStateRecord, userStateEntityKey,
  userStateJsonBytes, userStateWorkKey, type UserStateEntity, type UserStateOperation, type UserStateRecord,
} from "./types";

const work = { pluginId: "source", sourceNovelId: "Book-A", novelPath: "/book/a", name: "A" };
const entity: UserStateEntity = { kind: "reading", work, chapter: { chapterPath: "/chapter/1" } };
const operation: UserStateOperation = { operationId: "op-1", entity, baseRevision: 0, value: { progress: 0, unread: true, readAt: null } };
const record: UserStateRecord = { entity, value: operation.value, revision: 1, operationId: "op-1", updatedAt: 20, deviceId: "device", deviceName: "Tablet" };
const workspace = { version: 1, workspaceId: "workspace", epoch: "epoch", headRevision: 3 };

describe("portable user state protocol", () => {
  it("uses provider identities across devices without trusting local integer IDs, names or mutable work paths", () => {
    expect(userStateWorkKey(work)).toBe(userStateWorkKey({ ...work, sourceNovelId: "book-a", name: "Renamed", novelPath: "/new" }));
    expect(userStateWorkKey(work)).not.toBe(userStateWorkKey({ ...work, sourceNovelId: "Book-B" }));
    expect(userStateEntityKey(entity)).not.toBe(userStateEntityKey({ ...entity, work: { ...work, sourceNovelId: "Book-B" } }));
    expect(() => parseUserStateOperation({ ...operation, entity: { ...entity, novelId: 1, chapterId: 2 } })).toThrow("unexpected field");
  });

  it("retains explicit zero, unread, removal, unbookmark and null resume values", () => {
    expect(parseUserStateOperation(operation).value).toEqual({ progress: 0, unread: true, readAt: null });
    expect(parseUserStateOperation({ ...operation, entity: { kind: "bookmark", work, chapter: entity.chapter }, value: { bookmarked: false } }).value).toEqual({ bookmarked: false });
    expect(parseUserStateOperation({ ...operation, entity: { kind: "library", work }, value: { inLibrary: false, addedAt: null } }).value).toEqual({ inLibrary: false, addedAt: null });
    expect(parseUserStateOperation({ ...operation, entity: { kind: "resume", work }, value: { chapter: null, anchor: null, openedAt: null } }).value).toEqual({ chapter: null, anchor: null, openedAt: null });
    // Existing supported databases can contain this legacy tuple; parsing never invents MAX/OR rules.
    expect(parseUserStateOperation({ ...operation, value: { progress: 100, unread: true, readAt: 0 } }).value).toEqual({ progress: 100, unread: true, readAt: 0 });
  });

  it.each([
    { credentials: { deviceKey: "secret" } },
    { database: "raw snapshot" },
    { storageRoot: "/private/device/files" },
    { tasks: [] },
  ])("refuses unrelated device data in a shared change", extra => {
    expect(() => parseUserStateOperation({ ...operation, ...extra })).toThrow("unexpected field");
    expect(() => parseUserStateOperation({ ...operation, value: { ...operation.value, ...extra } })).toThrow("unexpected field");
  });

  it("keeps unknown work identities locally but refuses to publish them", () => {
    const local = { ...entity, work: { ...work, sourceNovelId: null } };
    expect(parseUserStateEntity(local)).toEqual(local);
    expect(() => parseUserStateOperation({ ...operation, entity: local })).toThrow("stable source work identity");
    expect(() => parseUserStateRecord({ ...record, entity: local })).toThrow("stable source work identity");
  });

  it.each(["norea-folder:2", "local-folder:2"])("defers unresolved numeric chapter identities in %s", chapterPath => {
    expect(() => parseUserStateOperation({ ...operation, entity: { ...entity, chapter: { chapterPath } } })).toThrow("recovered chapter identity");
    expect(() => parseUserStateOperation({ ...operation, entity: { kind: "resume", work },
      value: { chapter: { chapterPath }, anchor: null, openedAt: null } })).toThrow("recovered chapter identity");
  });

  it("uses a content hash chapter path within the shared local-files work", () => {
    const localWork = { pluginId: "local", sourceNovelId: "local", novelPath: "local", name: "Local files" };
    const first = { kind: "bookmark" as const, work: localWork, chapter: { chapterPath: "local:epub:hash-a/chapter-0001" } };
    const second = { ...first, chapter: { chapterPath: "local:epub:hash-b/chapter-0001" } };
    expect(userStateEntityKey(first)).not.toBe(userStateEntityKey(second));
  });

  it("validates the reader anchor without carrying viewport pages or device offsets", () => {
    const anchor = { segmentIndex: 3, segmentCount: 7, mediaOrdinal: 1, offset: 0.5, progress: 40, savedAt: 1000 };
    expect(parsePortableReaderAnchor(anchor)).toEqual(anchor);
    expect(() => parsePortableReaderAnchor({ ...anchor, offset: 18 })).toThrow("offset");
    expect(() => parsePortableReaderAnchor({ ...anchor, segmentIndex: 7 })).toThrow("outside");
    expect(() => parsePortableReaderAnchor({ ...anchor, pageIndex: 4 })).toThrow("unexpected field");
    expect(() => parseUserStateOperation({ ...operation, entity: { kind: "resume", work }, value: { chapter: null, anchor, openedAt: 1 } })).toThrow("empty resume");
  });

  it("does not let a seed carry a previously observed revision or remove validation boundaries", () => {
    expect(parseUserStateOperation({ ...operation, seed: true }).seed).toBe(true);
    expect(() => parseUserStateOperation({ ...operation, seed: true, baseRevision: 2 })).toThrow("seed");
    expect(() => parseUserStateOperation({ ...operation, seed: false })).toThrow("seed");
    expect(() => parseUserStateOperation({ ...operation, value: { progress: Infinity, unread: false, readAt: 1 } })).toThrow("progress");
    expect(() => parseUserStateOperation({ ...operation, value: { progress: 0, unread: true, readAt: -1 } })).toThrow("read time");
  });

  it("rejects non-progressing or inconsistent cursor pages and duplicate revisions", () => {
    const page = { ...workspace, through: 3, nextCursor: 1, hasMore: true, records: [record] };
    expect(parseUserStateReadResponse(page).nextCursor).toBe(1);
    expect(() => parseUserStateReadResponse({ ...page, records: [] })).toThrow("progress");
    expect(() => parseUserStateReadResponse({ ...page, nextCursor: 2 })).toThrow("cursor");
    expect(() => parseUserStateReadResponse({ ...page, records: [record, record] })).toThrow("revision order");
    expect(() => parseUserStateReadResponse({ ...page, through: 4 })).toThrow("cursors");
    expect(parseUserStateReadResponse({ ...workspace, through: 3, nextCursor: 3, hasMore: false, records: [] }).nextCursor).toBe(3);
  });

  it("allows a canonical category alias on a missing membership conflict and rejects false acknowledgements", () => {
    const response = { ...workspace, results: [{ operationId: "op-1", status: "conflict", current: null,
      reason: "category-deleted", categoryAlias: { from: "legacy-name", to: "canonical" } }] };
    expect(parseUserStateMergeResponse(response).results[0].categoryAlias).toEqual({ from: "legacy-name", to: "canonical" });
    expect(() => parseUserStateMergeResponse({ ...response, results: [{ ...response.results[0], status: "applied" }] })).toThrow("acknowledged");
    expect(() => parseUserStateMergeResponse({ ...response, results: [response.results[0], response.results[0]] })).toThrow("duplicate");
    expect(() => parseUserStateMergeResponse({ ...response, results: [{ ...response.results[0], categoryAlias: { from: "same", to: "same" } }] })).toThrow("alias");
  });

  it("counts actual UTF-8 bytes and canonicalizes exact payloads without serializing undefined", () => {
    expect(userStateJsonBytes("가")).toBe(5);
    expect(canonicalUserStateJson({ b: false, a: [0, null] })).toBe('{"a":[0,null],"b":false}');
    expect(() => canonicalUserStateJson({ credentials: undefined })).toThrow("portable JSON");
    expect(() => userStateJsonBytes(undefined)).toThrow("portable JSON");
  });
});
