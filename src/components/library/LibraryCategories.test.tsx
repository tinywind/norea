import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CategorySubpanel } from "./LibraryCategories";

it("renders no keyboard shortcut hints without matching handlers", () => {
  const t = (key: string) => key;
  const html = renderToStaticMarkup(
    <MantineProvider>
      <CategorySubpanel
        activeId={null} allCount={0} categories={[]} error={null} loading={false}
        onCreate={vi.fn()} onDelete={vi.fn()} onOpenDrawer={vi.fn()} onRename={vi.fn()} onSelect={vi.fn()}
        t={t} uncategorizedCount={0}
      />
    </MantineProvider>,
  );
  expect(load(html)("kbd")).toHaveLength(0);
});
