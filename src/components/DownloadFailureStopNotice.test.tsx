import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadFailureStops } from "../lib/tasks/download-failure-stop";
import type { TaskSnapshot } from "../lib/tasks/task-types";

const mocks = vi.hoisted(() => ({ resume: vi.fn(), direct: false, pending: null as string | null, busy: { current: false } }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => mocks.direct ? [mocks.pending, (next: string | null) => { mocks.pending = next; }] : react.useState(initial),
    useRef: (initial: unknown) => mocks.direct ? mocks.busy : react.useRef(initial),
  };
});
vi.mock("../lib/tasks/chapter-download", () => ({ resumeChapterDownloadQueueAfterFailure: mocks.resume }));
vi.mock("../lib/tasks/scheduler", () => ({ taskScheduler: { resumeSourceQueue: vi.fn() } }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { getPlugin: (id: string) => id === "installed" ? { name: "Installed source" } : undefined } }));
vi.mock("../i18n", async original => {
  const i18n = await original<typeof import("../i18n")>();
  return { ...i18n, useTranslation: () => ({ t: (key: import("../i18n").TranslationKey, values?: Record<string, string | number>) => i18n.translate("en", key, values) }) };
});
import { DownloadFailureStopNotice } from "./DownloadFailureStopNotice";

type NoticeSnapshot = Pick<TaskSnapshot, "records"> & { downloadFailureStops?: DownloadFailureStops };
function snapshot(stops?: DownloadFailureStops): NoticeSnapshot {
  return { records: [{ source: { id: "source-a", name: "Source A" } } as TaskSnapshot["records"][number]], ...(stops ? { downloadFailureStops: stops } : {}) };
}
function render(state: NoticeSnapshot) {
  mocks.direct = false;
  return load(renderToStaticMarkup(<MantineProvider><DownloadFailureStopNotice snapshot={state} /></MantineProvider>));
}
function direct(state: NoticeSnapshot) {
  mocks.direct = true;
  return DownloadFailureStopNotice({ snapshot: state });
}
interface Props { children?: ReactNode; onClick?: () => void | Promise<void>; disabled?: boolean; loading?: boolean }
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...elements(element.props.children)];
}
beforeEach(() => { vi.clearAllMocks(); mocks.resume.mockReset().mockResolvedValue(true); mocks.direct = false; mocks.pending = null; mocks.busy = { current: false }; });
afterEach(() => { vi.restoreAllMocks(); });

it("stays hidden when a snapshot has no failure stop", () => {
  expect(render(snapshot())("[role=alert]")).toHaveLength(0);
  expect(render(snapshot({ sourceErrors: {} }))("[role=alert]")).toHaveLength(0);
});

it("shows each stopped source name, actual error and semantic resume button", () => {
  const $ = render(snapshot({ sourceErrors: { "source-a": "HTTP 503 from source.test", installed: "Page parsing failed", unknown: "Network unavailable" } }));
  expect($("[role=alert]")).toHaveLength(3);
  expect($('[data-download-failure-stop="source-a"]').text()).toContain("Source A downloads stopped");
  expect($('[data-download-failure-stop="source-a"]').text()).toContain("HTTP 503 from source.test");
  expect($('[data-download-failure-stop="installed"]').text()).toContain("Installed source downloads stopped");
  expect($('[data-download-failure-stop="unknown"]').text()).toContain("unknown downloads stopped");
  expect($('[data-download-failure-stop="source-a"] button').text()).toBe("Resume source Source A");
  expect($('[data-download-failure-stop="source-a"] button').attr("type")).toBe("button");
});

it("shows a global save failure without hiding the independent source stop", () => {
  const $ = render(snapshot({ sourceErrors: { "source-a": "HTTP 503" }, globalError: "Disk is full" }));
  expect($("[role=alert]")).toHaveLength(2);
  expect($('[data-download-failure-stop="global"]').text()).toContain("Downloads stopped");
  expect($('[data-download-failure-stop="global"]').text()).toContain("Disk is full");
  expect($('[data-download-failure-stop="global"] button').text()).toBe("Resume downloads");
});

it("restores the queue before resuming only the selected source or explicit global scope", async () => {
  const view = direct(snapshot({ sourceErrors: { "source-a": "HTTP 503" }, globalError: "Disk is full" }));
  const sections = elements(view).filter(element => typeof element.type === "string" && element.type === "section");
  const source = sections.find(element => (element.props as Record<string, unknown>)["data-download-failure-stop"] === "source-a")!;
  await elements(source).find(element => element.props.onClick)!.props.onClick!();
  expect(mocks.resume).toHaveBeenLastCalledWith("source-a");
  const global = sections.find(element => (element.props as Record<string, unknown>)["data-download-failure-stop"] === "global")!;
  await elements(global).find(element => element.props.onClick)!.props.onClick!();
  expect(mocks.resume).toHaveBeenLastCalledWith();
});

it("keeps the clicked button loading and prevents duplicate recovery while queue restoration is pending", async () => {
  let finish!: (value: boolean) => void;
  mocks.resume.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }));
  const state = snapshot({ sourceErrors: {}, globalError: "Database unavailable" });
  const button = elements(direct(state)).find(element => element.props.onClick)!;
  const pending = button.props.onClick!();
  const waiting = elements(direct(state)).find(element => element.props.onClick)!;
  expect(waiting.props.loading).toBe(true);
  expect(waiting.props.disabled).toBe(true);
  await waiting.props.onClick!();
  expect(mocks.resume).toHaveBeenCalledOnce();
  finish(false);
  await pending;
  const settled = elements(direct(state));
  expect(settled.find(element => element.props.onClick)!.props.loading).toBe(false);
  expect(settled.some(element => element.props.children === "Database unavailable")).toBe(true);
});

it("settles a rejected recovery without leaving the button pending or hiding the stop", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.resume.mockRejectedValueOnce(new Error("Unexpected queue failure"));
  const state = snapshot({ sourceErrors: {}, globalError: "Disk is full" });
  const button = elements(direct(state)).find(element => element.props.onClick)!;
  await expect(Promise.resolve(button.props.onClick!())).resolves.toBeUndefined();
  const settled = elements(direct(state));
  expect(settled.find(element => element.props.onClick)!.props.loading).toBe(false);
  expect(settled.some(element => element.props.children === "Disk is full")).toBe(true);
});
