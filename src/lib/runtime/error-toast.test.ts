import { notifications, notificationsStore } from "@mantine/notifications";
import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { showErrorToast } from "./error-toast";

const clients = vi.hoisted(() => [] as QueryClient[]);

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...original,
    QueryClient: class extends original.QueryClient {
      constructor(...args: ConstructorParameters<typeof original.QueryClient>) {
        super(...args);
        clients.push(this);
      }
    },
  };
});
vi.mock("../../router", () => ({ router: {} }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => undefined }) }));
vi.mock("../../components/runtime/ChapterMediaStorageGate", () => ({ ChapterMediaStorageGate: () => null }));
vi.mock("../../components/runtime/PluginVpnProxyGate", () => ({ PluginVpnProxyGate: () => null }));
vi.mock("../content-sync/scheduler", () => ({ startContentServerSync: vi.fn() }));
vi.mock("../network", () => ({ initializeNetworkStatus: vi.fn() }));
vi.mock("../tasks/network-lifecycle", () => ({ initializeTaskNetworkState: vi.fn() }));
vi.mock("../tasks/vpn-download-runtime", () => ({ initializeVpnDownloadRuntime: vi.fn(async () => undefined) }));
vi.mock("../tasks/source-access-coordinator", () => ({ initializeSourceAccessCoordinator: vi.fn() }));
vi.mock("./viewport", () => ({ initializeRuntimeViewport: vi.fn(), useRuntimeViewport: vi.fn() }));
vi.mock("../logging", () => ({ installRuntimeLogLevelFilter: vi.fn(), setRuntimeLogLevel: vi.fn() }));

let client: QueryClient;

beforeEach(async () => {
  notifications.clean();
  if (!client) {
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("document", { getElementById: () => ({}) });
    await import("../../main");
    client = clients[0]!;
  }
});

afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  notifications.clean();
  client.clear();
  vi.useRealTimers();
});

it("leaves a mutation failure to its local error handler", async () => {
  const failure = new Error("Local deletion failed");
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => { throw failure; },
    onError: () => {
      notifications.show({ id: "local-delete", message: "Could not delete the chapter." });
    },
  });

  await expect(mutation.execute(undefined)).rejects.toBe(failure);

  expect(notificationsStore.getState().notifications).toHaveLength(1);
  expect(notificationsStore.getState().notifications[0]?.id).toBe("local-delete");
});

it("groups repeated failures from the same operation without extending their lifetime", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));

  showErrorToast("Source failed", new Error("First failure"), "source:a");
  vi.advanceTimersByTime(1000);
  showErrorToast("Source failed", new Error("First failure"), "source:a");

  expect(notificationsStore.getState().notifications).toHaveLength(1);

  const id = notificationsStore.getState().notifications[0]!.id!;
  notifications.hide(id);
  vi.advanceTimersByTime(4000);
  showErrorToast("Source failed", new Error("First failure"), "source:a");

  expect(notificationsStore.getState().notifications).toHaveLength(1);
});

it("keeps a fallback for mutation errors without a local presenter", async () => {
  const failure = new Error("Unowned action failed");
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => { throw failure; },
  });

  await expect(mutation.execute(undefined)).rejects.toBe(failure);

  expect(notificationsStore.getState().notifications).toHaveLength(1);
});

it("leaves inline mutation errors to their screen", async () => {
  const failure = new Error("Inline import failed");
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => { throw failure; },
    meta: { errorPresentation: "inline" },
  });

  await expect(mutation.execute(undefined)).rejects.toBe(failure);

  expect(notificationsStore.getState().notifications).toHaveLength(0);
});

it("keeps fallback presentation when a local callback only logs errors", async () => {
  const failure = new Error("Repository removal failed");
  const logFailure = vi.fn();
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => { throw failure; },
    onError: logFailure,
    meta: { errorPresentation: "toast" },
  });

  await expect(mutation.execute(undefined)).rejects.toBe(failure);

  expect(logFailure).toHaveBeenCalledWith(failure, undefined, undefined, expect.anything());
  expect(notificationsStore.getState().notifications).toHaveLength(1);
});

it("keeps a distinct failure from the same operation visible", () => {
  showErrorToast("Source failed", new Error("Network is offline"), "distinct:source-a");
  showErrorToast("Source failed", new Error("Storage is full"), "distinct:source-a");

  expect(notificationsStore.getState().notifications).toHaveLength(2);
});

it("keeps unrelated source errors in separate groups", () => {
  showErrorToast("Source failed", new Error("Source A"), "separate:source-a");
  showErrorToast("Source failed", new Error("Source B"), "separate:source-b");

  expect(notificationsStore.getState().notifications).toHaveLength(2);
});

it("keeps fallback presentation for a query without an inline owner", async () => {
  const failure = new Error("Background query failed");

  await expect(client.fetchQuery({
    queryKey: ["unowned-background"],
    queryFn: async () => { throw failure; },
    retry: false,
  })).rejects.toBe(failure);

  expect(notificationsStore.getState().notifications).toEqual([
    expect.objectContaining({ color: "red", message: "Background query failed", autoClose: 5000 }),
  ]);
});

it("leaves inline query errors to their screen", async () => {
  const failure = new Error("Source listing failed");

  await expect(client.fetchQuery({
    queryKey: ["source-list", "source-a"],
    queryFn: async () => { throw failure; },
    retry: false,
    meta: { errorPresentation: "inline" },
  })).rejects.toBe(failure);

  expect(notificationsStore.getState().notifications).toHaveLength(0);
});
