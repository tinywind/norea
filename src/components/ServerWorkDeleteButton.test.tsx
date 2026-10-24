import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), change: vi.fn(), deleted: vi.fn(), mutate: vi.fn(),
  mutation: null as null | { mutationFn: () => Promise<boolean>; onSuccess: (changed: boolean) => void },
}));
vi.mock("@tanstack/react-query", () => ({ useMutation: (options: typeof mocks.mutation) => {
  mocks.mutation = options; return { mutate: mocks.mutate, isPending: false };
} }));
vi.mock("../store/content-deletion", () => ({ confirmContentDeletion: mocks.confirm }));
vi.mock("../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ServerWorkDeleteButton } from "./ServerWorkDeleteButton";
const source = { serverUrl: "http://displayed-server", workId: "work-id" };
beforeEach(() => vi.clearAllMocks());

it.each([false, true])("uses the displayed server and reports deletion only when confirmation changed data (%s)", async changed => {
  let finish!: (value: boolean) => void;
  mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  ServerWorkDeleteButton({ source, name: "Book", onOpenChange: mocks.change, onDeleted: mocks.deleted });
  const pending = mocks.mutation!.mutationFn();
  expect(mocks.change).toHaveBeenCalledExactlyOnceWith(true);
  expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({ kind: "server-work", source, title: "Book" });
  finish(changed);
  const result = await pending;
  mocks.mutation!.onSuccess(result);
  expect(mocks.change).toHaveBeenLastCalledWith(false);
  expect(mocks.deleted).toHaveBeenCalledTimes(changed ? 1 : 0);
});
