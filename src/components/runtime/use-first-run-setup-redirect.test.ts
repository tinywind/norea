import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  navigate: vi.fn(),
  plugins: [] as unknown[],
  repositories: [] as unknown[],
  setupState: null as string | null,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    mocks.effects.push(effect);
  },
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../db/queries/repository", () => ({ listRepositories: async () => mocks.repositories }));
vi.mock("../../lib/plugins/manager", () => ({
  pluginManager: { list: () => mocks.plugins, loadInstalledFromDb: async () => undefined },
}));
vi.mock("../../store/setup", () => ({
  useSetupStore: Object.assign(
    (select: (state: { setupState: string | null }) => unknown) => select({ setupState: mocks.setupState }),
    { getState: () => ({ setupState: mocks.setupState }) },
  ),
}));

import { useFirstRunSetupRedirect } from "./use-first-run-setup-redirect";

async function launch(pathname: string) {
  mocks.effects = [];
  useFirstRunSetupRedirect(pathname);
  mocks.effects.forEach((effect) => effect());
  await vi.waitFor(() => undefined);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.plugins = [];
  mocks.repositories = [];
  mocks.setupState = null;
});

it("opens the setup on a fresh Library launch", async () => {
  await launch("/");
  await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ replace: true, to: "/setup" }));
});

it("leaves an existing install and a deep-linked launch alone", async () => {
  mocks.repositories = [{ id: 1, url: "https://repo.test" }];
  await launch("/");
  mocks.repositories = [];
  await launch("/reader");
  mocks.setupState = "skipped";
  await launch("/");
  expect(mocks.navigate).not.toHaveBeenCalled();
});
