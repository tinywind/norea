import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ server: "http://server", click: undefined as (() => void) | undefined,
  mutate: vi.fn(), invalidate: vi.fn(), show: vi.fn(), options: undefined as unknown }));
vi.mock("@mantine/core", () => ({ Button: (props: { onClick: () => void; children: string; disabled: boolean }) => {
  mocks.click = props.onClick; return <button disabled={props.disabled}>{props.children}</button>;
} }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: (options: unknown) => { mocks.options = options; return { mutate: mocks.mutate, isPending: false }; },
}));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: (select: (state: { serverUrl: string }) => unknown) => select({ serverUrl: mocks.server }) }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/content-sync/sync", () => ({ deleteServerChapters: vi.fn() }));
import { deleteServerChapters } from "../../lib/content-sync/sync";
import { ServerChapterDelete } from "./ServerChapterDelete";

beforeEach(() => { vi.clearAllMocks(); mocks.server = "http://server"; vi.stubGlobal("window", { confirm: vi.fn(() => true) }); });
const render = (selected = true) => renderToStaticMarkup(<ServerChapterDelete novel={{ pluginId: "source", path: "/book" }} chapters={selected ? [{ path: "/chapter/1", chapterNumber: "1" }] : []} />);

it("has an explicit server-only label and makes no server request while rendering", () => {
  expect(render()).toContain("contentSync.deleteServer");
  expect(deleteServerChapters).not.toHaveBeenCalled();
  expect(render(false)).toContain('disabled=""');
  mocks.server = "";
  expect(render()).toBe("");
});

it("confirms selected chapters and refreshes only server queries after deletion", async () => {
  render();
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  mocks.click!(); expect(mocks.mutate).not.toHaveBeenCalled();
  mocks.click!(); expect(mocks.mutate).toHaveBeenCalledTimes(1);
  const options = mocks.options as { mutationFn: () => Promise<void>; onSuccess: () => void };
  await options.mutationFn(); options.onSuccess();
  expect(deleteServerChapters).toHaveBeenCalledWith([{ pluginId: "source", novelPath: "/book", chapterPath: "/chapter/1", chapterNumber: "1" }]);
  expect(mocks.invalidate.mock.calls).toEqual([
    [{ queryKey: ["content-server", "novel-chapters"] }],
    [{ queryKey: ["content-server", "http://server", "browse"] }],
  ]);
});
