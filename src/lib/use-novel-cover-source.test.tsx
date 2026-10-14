import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("./novel-cover-storage", () => ({
  getNovelCoverSnapshot: () => 0,
  peekCachedNovelCoverSrc: () => "blob:already-loaded-cover",
  subscribeNovelCoverChanges: () => () => undefined,
  acquireCachedNovelCoverSource: vi.fn(),
}));
vi.mock("./plugins/manager", () => ({
  pluginManager: { getPlugin: () => null },
}));

import { useNovelCoverSource } from "./use-novel-cover-source";

it("shows a previously loaded browse cover on the first render without a database id", () => {
  function Cover() {
    const src = useNovelCoverSource({ id: 0, pluginId: "demo", path: "/book", name: "Book", cover: "/cover.jpg" }, { allowSourceFallback: true });
    return <span data-cover={src} />;
  }
  expect(renderToStaticMarkup(<Cover />)).toContain('data-cover="blob:already-loaded-cover"');
});
