import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import type { ReaderChapterRow } from "../../lib/reader-chapter";
import { chapterContentToHtml, sanitizeReaderHtml } from "../../lib/chapter-content";
import { chapterDetailQueryKey } from "../../lib/reader-query-invalidation";
import { prepareReaderDocument } from "../reader-document";
import { canPreRenderReaderDocument, useNextReaderChapter } from "./use-next-reader-chapter";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  data: null as ReaderChapterRow | null,
  isCurrent: true,
  query: vi.fn(),
  prepare: vi.fn(),
  invalidate: vi.fn(),
  subscribe: vi.fn(),
  client: {},
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
  useMemo: <T,>(factory: () => T) => factory(),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options: unknown) => { mocks.query(options); return { data: mocks.data }; },
  useQueryClient: () => mocks.client,
}));
vi.mock("../../lib/reader-query-invalidation", async original => ({
  ...await original<typeof import("../../lib/reader-query-invalidation")>(),
  invalidateReaderContentQueries: (...args: unknown[]) => mocks.invalidate(...args),
}));
vi.mock("../../lib/chapter-media", () => ({
  hasRemoteChapterMedia: (html: string) => /src="https?:/.test(html),
}));
vi.mock("../../lib/tasks/chapter-download", () => ({
  subscribeChapterDownloads: (...args: unknown[]) => mocks.subscribe(...args),
}));
vi.mock("../use-reader-document", () => ({
  useReaderDocument: (html: string | null, bionic: boolean, id: number) => {
    mocks.prepare(html, bionic, id);
    return { document: html ? prepareReaderDocument(html, bionic) : undefined, isCurrent: mocks.isCurrent };
  },
}));

const chapter = {
  id: 2, novelId: 7, isDownloaded: true, contentBytes: 11,
  content: "<p>Next</p>", contentType: "html", name: "Next", position: 2,
} as ReaderChapterRow;
const options = {
  active: true,
  currentChapterReady: true,
  nextChapter: chapter as ChapterListRow,
  currentNovelId: 7,
  bionicReading: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.data = chapter;
  mocks.isCurrent = true;
});

describe("next reader chapter rendering preparation", () => {
  it("reuses the stored chapter query and returns its prepared document", () => {
    const result = useNextReaderChapter(options);
    expect(result?.chapter).toBe(chapter);
    expect(result?.document.html).toContain("Next");
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: chapterDetailQueryKey(2), enabled: true, retry: false,
    }));
    expect(mocks.prepare).toHaveBeenCalledWith(chapter.content, false, 2);
  });

  it.each([
    { active: false },
    { currentChapterReady: false },
    { nextChapter: undefined },
    { currentNovelId: 8 },
    { nextChapter: { ...chapter, isDownloaded: false, contentBytes: 0 } as ChapterListRow },
  ])("does not prepare while ineligible: %j", change => {
    expect(useNextReaderChapter({ ...options, ...change })).toBeNull();
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(mocks.prepare).toHaveBeenCalledWith(null, false, 0);
  });

  it.each([
    { ...chapter, id: 3 },
    { ...chapter, novelId: 8 },
    { ...chapter, isDownloaded: false, contentBytes: 0 },
    { ...chapter, contentType: "pdf" as const },
  ])("ignores stale or non-HTML query data: %j", data => {
    mocks.data = data;
    expect(useNextReaderChapter(options)).toBeNull();
    expect(mocks.prepare).toHaveBeenCalledWith(null, false, 2);
  });

  it("keeps the old bionic/document result out of the hidden renderer while its replacement is pending", () => {
    mocks.isCurrent = false;
    expect(useNextReaderChapter({ ...options, bionicReading: true })).toBeNull();
    expect(mocks.prepare).toHaveBeenCalledWith(chapter.content, true, 2);
  });

  it("drops the previous candidate after a chapter jump", () => {
    expect(useNextReaderChapter({ ...options, nextChapter: { ...chapter, id: 9 } as ChapterListRow })).toBeNull();
    expect(mocks.prepare).toHaveBeenCalledWith(null, false, 9);
  });

  it("invalidates the exact upcoming chapter when its download finishes", () => {
    const unsubscribe = vi.fn();
    mocks.subscribe.mockReturnValue(unsubscribe);
    useNextReaderChapter(options);
    expect(mocks.effects[0]!()).toBe(unsubscribe);
    const listener = mocks.subscribe.mock.calls[0]![0];
    listener({ job: { id: 3 }, status: { kind: "done" } });
    listener({ job: { id: 2 }, status: { kind: "running" } });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    listener({ job: { id: 2 }, status: { kind: "done" } });
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(mocks.client, { chapterId: 2, novelId: 7 });
  });
});

describe("side-effect-free hidden document eligibility", () => {
  it.each([
    ["plain text", chapterContentToHtml("Chapter two\n\nFirst paragraph.\nSecond line.\n\nAnother paragraph.", "text")],
    ["markdown", chapterContentToHtml("# Chapter two\n\nA **bold** sentence.\n\nAnother paragraph.", "markdown")],
    ["captured novel HTML", sanitizeReaderHtml('<article class="chapter"><h2>Chapter two</h2><p>First paragraph.<br>Another line.</p><p>Last paragraph.</p></article>')],
  ])("pre-renders normal %s output from the real content pipeline", (_format, html) => {
    const prepared = prepareReaderDocument(html, false);
    expect(prepared.virtualDocument.staticHtml).toBe("");
    expect(canPreRenderReaderDocument(prepared)).toBe(true);
    expect(canPreRenderReaderDocument(prepareReaderDocument(html, true))).toBe(true);
  });

  it("allows plain content and already stored local images", () => {
    expect(canPreRenderReaderDocument(prepareReaderDocument("<p>Next</p>", false))).toBe(true);
    expect(canPreRenderReaderDocument(prepareReaderDocument('<img src="norea-media://reader-asset/image.jpg">', false))).toBe(true);
  });

  it.each([
    '<style>p { color: red }</style><p>Next</p>',
    '<img src="https://source.example/page.jpg">',
    '<video autoplay src="data:video/mp4;base64,AA=="></video>',
    '<iframe src="about:blank"></iframe>',
    '<p onclick="run()">Next</p>',
  ])("keeps document preparation without mounting active content: %s", html => {
    expect(canPreRenderReaderDocument(prepareReaderDocument(html, false))).toBe(false);
  });
});
