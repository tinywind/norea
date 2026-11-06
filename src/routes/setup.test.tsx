import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginItem } from "../lib/plugins/types";

interface MutationOptions {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSettled?: () => void;
  onSuccess?: (result: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  back: null as null | (() => boolean),
  mutations: [] as Array<{ mutate: ReturnType<typeof vi.fn>; options: MutationOptions }>,
  mutationIndex: 0,
  navigate: vi.fn(),
  pendingRepoUrl: null as string | null,
  setSetupState: vi.fn(),
  state: [] as unknown[],
  stateIndex: 0,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => undefined,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.state)) mocks.state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [mocks.state[index], (next: unknown) => {
      mocks.state[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(mocks.state[index]) : next;
    }];
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: MutationOptions) => {
    const index = mocks.mutationIndex++;
    mocks.mutations[index] ??= { mutate: vi.fn(), options };
    mocks.mutations[index]!.options = options;
    return { error: null, isPending: false, mutate: mocks.mutations[index]!.mutate };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../i18n", () => ({
  formatPluginLanguageForLocale: (_locale: string, lang: string) => lang,
  useTranslation: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../lib/android-back-navigation", () => ({
  usePageBackNavigation: (onBack: () => boolean) => {
    mocks.back = onBack;
  },
}));
vi.mock("../store/setup", () => ({
  useSetupStore: (select: (state: { setSetupState: typeof mocks.setSetupState }) => unknown) =>
    select({ setSetupState: mocks.setSetupState }),
}));
vi.mock("../store/browse", () => ({
  useBrowseStore: (select: (state: { clearPendingRepoUrl: () => void; pendingRepoUrl: string | null }) => unknown) =>
    select({ clearPendingRepoUrl: vi.fn(), pendingRepoUrl: mocks.pendingRepoUrl }),
}));
vi.mock("../db/queries/repo-index-cache", () => ({ setCachedRepoIndex: vi.fn() }));
vi.mock("../db/queries/repository", () => ({ upsertRepository: vi.fn() }));
vi.mock("../lib/plugins/manager", () => ({ pluginManager: { fetchRepository: vi.fn(), installPlugin: vi.fn() } }));
vi.mock("../lib/tasks/main-tasks", () => ({ enqueueMainTask: vi.fn() }));

import { PAGE_SLOT_PROPS } from "../lib/android-back-navigation.test-support";
import { SetupPage } from "./setup";

interface Props {
  selected?: boolean;
  checked?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  label?: ReactNode;
  onChange?: (event: unknown) => void;
  onClick?: () => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  const slots = node.props as Record<string, unknown>;
  return [
    node,
    ...PAGE_SLOT_PROPS.flatMap((slot) => Children.toArray(slots[slot] as ReactNode).flatMap(elements)),
    ...Children.toArray(node.props.children).flatMap(elements),
  ];
}

function render() {
  mocks.stateIndex = 0;
  mocks.mutationIndex = 0;
  return elements(SetupPage());
}

const text = (element: ReactElement<Props>) =>
  Children.toArray(element.props.children).filter((child) => typeof child === "string").join("");
const button = (tree: ReactElement<Props>[], label: string) =>
  tree.find((element) => typeof element.props.onClick === "function" && text(element) === label);

const item = (id: string, lang: string) =>
  ({ id, lang, name: `Source ${id}`, site: "https://s.test", url: `https://r.test/${id}.js`, version: "1" }) as unknown as PluginItem;

beforeEach(() => {
  mocks.state = [];
  mocks.mutations = [];
  mocks.navigate.mockClear();
  mocks.setSetupState.mockClear();
  mocks.pendingRepoUrl = null;
});

describe("first-run setup", () => {
  it("adds the pasted repository, preselects the app language and suggests its sources", () => {
    let tree = render();
    expect(tree.some((element) => element.props.children === "setup.step")).toBe(true);
    const input = tree.find((element) => element.props.label === "browse.repositoryUrl")!;
    input.props.onChange!({ currentTarget: { value: " https://repo.test/index.json " } });
    tree = render();
    tree.find((element) => typeof element.props.onSubmit === "function")!.props.onSubmit!({ preventDefault: vi.fn() });
    expect(mocks.mutations[0]!.mutate).toHaveBeenCalledWith("https://repo.test/index.json");

    mocks.mutations[0]!.options.onSuccess!([item("b", "en"), item("a", "en"), item("k", "ko")]);
    tree = render();
    const chips = tree.filter((element) => element.props.selected !== undefined);
    expect(chips.map((chip) => [text(chip), chip.props.selected])).toEqual([["en", true], ["ko", false]]);

    button(tree, "setup.continue")!.props.onClick!();
    tree = render();
    const boxes = tree.filter((element) => element.props.checked !== undefined);
    expect(boxes.map((box) => [box.props.label, box.props.checked])).toEqual([["Source a", true], ["Source b", true]]);

    tree.find((element) => text(element) === "setup.sources.install")!.props.onClick!();
    expect(mocks.mutations[1]!.mutate).toHaveBeenCalledWith([expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "b" })]);
  });

  it("ends on Done, records the setup as done and opens the sources", () => {
    render();
    mocks.mutations[0]!.options.onSuccess!([item("a", "en")]);
    let tree = render();
    button(tree, "setup.continue")!.props.onClick!();
    render();
    mocks.mutations[1]!.options.onSuccess!({ failed: [], installed: 1 });
    tree = render();
    expect(button(tree, "setup.skip")).toBeUndefined();
    button(tree, "setup.done.action")!.props.onClick!();
    expect(mocks.setSetupState).toHaveBeenCalledWith("done");
    expect(mocks.navigate).toHaveBeenCalledWith({ replace: true, search: { q: "", tab: "search" }, to: "/browse" });
  });

  it("records a skip from any step so setup never returns", () => {
    button(render(), "setup.skip")!.props.onClick!();
    expect(mocks.setSetupState).toHaveBeenCalledWith("skipped");
    expect(mocks.navigate).toHaveBeenCalledWith({ replace: true, to: "/" });
  });

  it("steps back one step on Android back and leaves the first step to the system", () => {
    render();
    expect(mocks.back!()).toBe(false);
    mocks.mutations[0]!.options.onSuccess!([item("a", "en")]);
    render();
    expect(mocks.back!()).toBe(true);
    expect(render().some((element) => element.props.label === "browse.repositoryUrl")).toBe(true);
  });
});
