import type { ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkCatalogEntry } from "../lib/content-sync/works";

const mocks = vi.hoisted(() => ({
  opened: false,
  pending: false,
  error: null as Error | null,
  change: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  deleted: vi.fn(),
  remove: vi.fn(),
  updateCache: vi.fn(async () => undefined),
  notify: vi.fn(),
  queryClient: {},
  mutation: null as null | { mutationFn: () => Promise<WorkCatalogEntry>; onSuccess: (entry: WorkCatalogEntry) => Promise<void> },
  back: null as null | (() => boolean),
}));

vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: () => [mocks.opened, (value: boolean) => { mocks.opened = value; }],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
  useMutation: (options: typeof mocks.mutation) => {
    mocks.mutation = options;
    return { isPending: mocks.pending, error: mocks.error, mutate: mocks.mutate, reset: mocks.reset };
  },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string, values?: { name: string }) => values ? `${key}:${values.name}` : key }) }));
vi.mock("../lib/android-back-navigation", () => ({ usePageBackNavigation: (back: () => boolean) => { mocks.back = back; } }));
vi.mock("../lib/content-sync/management", () => ({ deleteServerWork: mocks.remove }));
vi.mock("../lib/content-sync/management-query-cache", () => ({ removeDeletedServerWorkFromQueries: mocks.updateCache }));

import { Modal } from "@mantine/core";
import { ServerWorkDeleteButton } from "./ServerWorkDeleteButton";
import { TextButton } from "./TextButton";

interface ControlProps {
  children?: ReactNode;
  onClick?: () => void;
  onClose?: () => void;
  opened?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}
function controls(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ControlProps>;
  return [element, ...controls(element.props.children)];
}
const source = { serverUrl: "http://displayed-server", workId: "work-id" };
const render = () => controls(ServerWorkDeleteButton({ source, name: "Original novel", onOpenChange: mocks.change, onDeleted: mocks.deleted }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.opened = false; mocks.pending = false; mocks.error = null; mocks.mutation = null;
});

it("requires confirmation with the work name and displayed server before deleting", async () => {
  const initial = render();
  expect(initial.find(element => element.type === Modal)?.props.opened).toBe(false);
  initial.find(element => element.props["aria-label"] === "contentSync.deleteWorkServer: Original novel")!.props.onClick!();
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(mocks.change).toHaveBeenCalledWith(true);
  const confirmation = render();
  expect(confirmation.find(element => element.type === Modal)?.props.opened).toBe(true);
  expect(confirmation.some(element => element.props.children === "contentSync.deleteWorkConfirm:Original novel")).toBe(true);
  expect(confirmation.some(element => element.props.children === source.serverUrl)).toBe(true);
  const buttons = confirmation.filter(element => element.type === TextButton);
  buttons.at(-1)!.props.onClick!();
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith();
  await mocks.mutation!.mutationFn();
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(source);
});

it("keeps a failed deletion open and only removes query data after success", async () => {
  mocks.opened = true;
  mocks.error = new Error("Deletion was rejected");
  const failed = render();
  expect(failed.find(element => element.type === Modal)?.props.opened).toBe(true);
  expect(failed.some(element => element.props.children === "Deletion was rejected")).toBe(true);
  expect(mocks.updateCache).not.toHaveBeenCalled();
  expect(mocks.deleted).not.toHaveBeenCalled();
  const entry = { id: source.workId, deleted: true } as WorkCatalogEntry;
  await mocks.mutation!.onSuccess(entry);
  expect(mocks.updateCache).toHaveBeenCalledExactlyOnceWith(mocks.queryClient, source, entry);
  expect(mocks.change).toHaveBeenCalledWith(false);
  expect(mocks.deleted).toHaveBeenCalledOnce();
  expect(mocks.notify).toHaveBeenCalledWith({ message: "contentSync.deleteWorkDone" });
});

it("cancels without a request and prevents closing while deletion is pending", () => {
  mocks.opened = true;
  const confirmation = render();
  confirmation.find(element => element.props.children === "common.cancel")!.props.onClick!();
  expect(mocks.opened).toBe(false);
  expect(mocks.mutate).not.toHaveBeenCalled();
  mocks.opened = true; mocks.pending = true;
  const pending = render();
  expect(pending.find(element => element.props.children === "common.cancel")!.props.disabled).toBe(true);
  pending.find(element => element.type === Modal)!.props.onClose!();
  expect(mocks.back!()).toBe(true);
  expect(mocks.opened).toBe(true);
});
