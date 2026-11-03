import { describe, expect, it } from "vitest";
import { repositoryLabel } from "./RepositoriesDialog";

describe("repositoryLabel", () => {
  it("prefers the stored name", () => {
    expect(repositoryLabel({ name: " Mine ", url: "https://example.test/plugins.json" })).toBe("Mine");
  });

  it("names GitHub repositories by owner and repository", () => {
    expect(repositoryLabel({
      name: null,
      url: "https://raw.githubusercontent.com/tinywind/norea-plugins/dist/0.2/.dist/plugins.json",
    })).toBe("tinywind/norea-plugins");
  });

  it("falls back to the host, then to the URL itself", () => {
    expect(repositoryLabel({ name: null, url: "https://plugins.example.test:8443/index.json" }))
      .toBe("plugins.example.test:8443");
    expect(repositoryLabel({ name: "", url: "not a url" })).toBe("not a url");
  });
});
