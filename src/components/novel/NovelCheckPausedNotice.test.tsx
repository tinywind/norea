import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ freshness: null as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled: boolean }) => ({ data: options.enabled ? mocks.freshness : undefined }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../i18n", () => ({
  formatDateForLocale: (_locale: string, value: number) => new Date(value).toISOString().slice(0, 10),
  useTranslation: () => ({ locale: "en", t: (key: string, values?: { date?: string }) => values?.date ? `${key}:${values.date}` : key }),
}));

import { NovelCheckPausedNotice } from "./NovelCheckPausedNotice";

const checkNow = { isPending: false, mutate: vi.fn() };
const render = (active = true) => load(renderToStaticMarkup(
  <MantineProvider><NovelCheckPausedNotice active={active} checkNow={checkNow} novelId={3} /></MantineProvider>,
));

beforeEach(() => {
  mocks.freshness = { consecutiveFailures: 3, lastSuccessAt: Date.UTC(2026, 10, 2) / 1000 };
});

it("shows paused checking with the last success and Check now once checks back off", () => {
  const $ = render();
  expect($("[role=status]").text()).toContain("novel.checkPaused:2026-11-02");
  expect($("button").text()).toBe("updates.checkNow");
});

it("says every check failed when none ever succeeded", () => {
  mocks.freshness = { consecutiveFailures: 4, lastSuccessAt: null };
  expect(render()("[role=status]").text()).toContain("novel.checkPausedNeverSucceeded");
});

it("stays hidden before the backoff or while a check runs", () => {
  mocks.freshness = { consecutiveFailures: 2, lastSuccessAt: null };
  expect(render()("[role=status]").length).toBe(0);
  mocks.freshness = { consecutiveFailures: 3, lastSuccessAt: null };
  expect(render(false)("[role=status]").length).toBe(0);
});
