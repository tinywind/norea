import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { NovelDetailRecord } from "../../db/queries/novel";

const mocks = vi.hoisted(() => ({ setDownloadGoal: vi.fn(), show: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values ? `${key}(${JSON.stringify(values)})` : key,
  }),
}));
vi.mock("../../lib/download-goals/goal-service", () => ({
  getDownloadGoalPauseSnapshot: () => ({ pause: null }),
  subscribeDownloadGoalPause: () => () => undefined,
  setDownloadGoal: mocks.setDownloadGoal,
}));

import { BRIEF_TOAST_AUTO_CLOSE_MS } from "../ui/AppToasts";
import { useNovelDownloadGoalChoice } from "./NovelActions";

const chapter = (id: number, extra: Partial<ChapterListRow> = {}) => ({
  id, novelId: 3, name: `Chapter ${id}`, path: `/${id}`, chapterNumber: String(id), position: id, page: "1",
  bookmark: false, unread: true, progress: 0, isDownloaded: false, sourceContentType: "html", contentType: "html",
  contentBytes: 0, mediaBytes: 0, mediaRepairNeeded: false, releaseTime: null, readAt: null, createdAt: null, foundAt: 1, updatedAt: 1,
  ...extra,
}) as ChapterListRow;
const novel = {
  id: 3, pluginId: "source", sourceNovelId: "n", path: "/novel", name: "Novel", cover: null, summary: null, author: null,
  artist: null, status: null, genres: null, rating: null, inLibrary: true, isLocal: false, createdAt: 1, updatedAt: 1,
  libraryAddedAt: 1, lastReadAt: null,
} as NovelDetailRecord;
const chapters = [chapter(1, { isDownloaded: true, contentBytes: 1 }), chapter(2), chapter(3), chapter(4)];

let root: Root;
let choice: ReturnType<typeof useNovelDownloadGoalChoice>;
const onClose = vi.fn();

function Probe() {
  choice = useNovelDownloadGoalChoice({
    chapters, downloadStatuses: new Map([[4, { kind: "queued" }]]), lastReadChapterId: 1, novel, onClose,
  });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.setDownloadGoal.mockResolvedValue(undefined);
  const document = { nodeType: 9, activeElement: null, body: null as unknown, documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("closes the sheet and briefly says what was set and how many chapters it queues", async () => {
  await act(async () => choice.choose({ kind: "all_remaining" }, null));
  expect(mocks.setDownloadGoal).toHaveBeenCalledWith(3, { kind: "all_remaining" });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mocks.show).toHaveBeenCalledWith({
    autoClose: BRIEF_TOAST_AUTO_CLOSE_MS,
    color: "ok",
    message: 'downloadGoals.chosen.allRemaining · downloadGoals.chosen.queued({"count":2})',
  });
});

it("names the keep-ahead count and says when no chapter downloads", async () => {
  await act(async () => choice.choose({ kind: "keep_ahead", count: 5 }, null));
  expect(mocks.show.mock.calls[0]![0].message).toBe(
    'downloadGoals.chosen.keepAhead({"count":5}) · downloadGoals.chosen.queued({"count":2})',
  );
  await act(async () => choice.choose({ kind: "none" }, { kind: "keep_ahead", count: 5 }));
  expect(mocks.show.mock.calls[1]![0].message).toBe("downloadGoals.chosen.none");
});

it("only closes when the active choice is picked again", async () => {
  await act(async () => choice.choose({ kind: "entire" }, { kind: "entire" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mocks.setDownloadGoal).not.toHaveBeenCalled();
  expect(mocks.show).not.toHaveBeenCalled();
});

it("keeps the sheet open with the error when the write fails, and shows the write in progress", async () => {
  let reject!: (error: Error) => void;
  mocks.setDownloadGoal.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  let pending!: Promise<void>;
  await act(async () => { pending = choice.choose({ kind: "entire" }, null); });
  expect(choice.saving).toBe(true);
  await act(async () => { reject(new Error("database is locked")); await pending; });
  expect(choice.saving).toBe(false);
  expect(choice.error).toEqual(new Error("database is locked"));
  expect(onClose).not.toHaveBeenCalled();
  expect(mocks.show).not.toHaveBeenCalled();
});
