import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContentDeletionAction, ContentDeletionRequest, ContentDeletionResult } from "../lib/content-deletion";

interface SheetProps { footer: ReactNode; onClose: () => Promise<void> | void }
const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  note: vi.fn(async () => []),
  offer: vi.fn(async () => undefined),
  prepare: vi.fn(),
  request: null as ContentDeletionRequest | null,
  run: vi.fn(),
  sheet: null as SheetProps | null,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries: vi.fn(async () => undefined), invalidateQueries: vi.fn(async () => undefined) }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { pathname: "/downloads", search: {} } } }),
}));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../lib/content-deletion", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/content-deletion")>(),
  prepareContentDeletion: mocks.prepare,
  runContentDeletion: mocks.run,
}));
vi.mock("../lib/content-sync/management-query-cache", () => ({ removeDeletedServerWorkFromQueries: vi.fn() }));
vi.mock("../lib/download-goals/goal-service", () => ({ noteDownloadDeletion: mocks.note }));
vi.mock("../lib/updates/update-index-events", () => ({ markUpdatesIndexDirty: vi.fn() }));
vi.mock("../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("./use-stop-download-goals-offer", () => ({ useStopDownloadGoalsOffer: () => mocks.offer }));
vi.mock("./ui/ResponsiveSheet", () => ({
  ResponsiveSheet: (props: SheetProps) => { mocks.sheet = props; return null; },
  SheetActions: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../store/content-deletion", () => ({
  finishContentDeletion: mocks.finish,
  useContentDeletionStore: (select: (state: unknown) => unknown) =>
    select({ pending: mocks.request ? { id: 1, request: mocks.request, resolve: vi.fn() } : null }),
}));

import { ContentDeletionDialog } from "./ContentDeletionDialog";

let root: Root;
const request: ContentDeletionRequest = { kind: "downloads", scope: "novel", ids: [3, 4], title: "Delete", serverUrl: "" };
const action = (id: string, downloadedChapterIds: number[]): ContentDeletionAction =>
  ({ id, side: "device", name: id, downloadedChapterIds, run: vi.fn() });
const plan = [action("device:3", [31, 32]), action("device:4", [41])];

function confirmButton(): ReactElement<{ onClick: () => void }> {
  const buttons = (mocks.sheet!.footer as ReactElement<{ children: ReactNode[] }>).props.children;
  return buttons.filter(isValidElement).at(-1) as ReactElement<{ onClick: () => void }>;
}

async function confirm(results: ContentDeletionResult[]): Promise<void> {
  mocks.run.mockImplementation(async (_plan, _previous, onResult: (results: ContentDeletionResult[]) => void) => {
    onResult(results);
    return results;
  });
  await act(async () => { confirmButton().props.onClick(); });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue(plan);
  mocks.request = request;
  const document = { nodeType: 9, activeElement: null, body: null as unknown, documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Node", class {});
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<ContentDeletionDialog />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("offers to stop download goals for the chapters the deletion removed", async () => {
  await confirm([{ id: "device:3", status: "succeeded" }, { id: "device:4", status: "succeeded" }]);
  expect(mocks.offer).toHaveBeenCalledExactlyOnceWith([31, 32, 41]);
  expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(1, true);
});

it("keeps deleted chapters out of goals after a partial failure and offers to stop them on close", async () => {
  await confirm([{ id: "device:3", status: "succeeded" }, { id: "device:4", status: "failed", error: "busy" }]);
  expect(mocks.note).toHaveBeenCalledExactlyOnceWith([31, 32]);
  expect(mocks.offer).not.toHaveBeenCalled();
  expect(mocks.finish).not.toHaveBeenCalled();
  await act(async () => { await mocks.sheet!.onClose(); });
  expect(mocks.offer).toHaveBeenCalledExactlyOnceWith([31, 32]);
  expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(1, true);
});

it("makes no goal offer when no deletion succeeded", async () => {
  await confirm([{ id: "device:3", status: "failed", error: "busy" }, { id: "device:4", status: "failed", error: "busy" }]);
  await act(async () => { await mocks.sheet!.onClose(); });
  expect(mocks.note).not.toHaveBeenCalled();
  expect(mocks.offer).not.toHaveBeenCalled();
  expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(1, false);
});
