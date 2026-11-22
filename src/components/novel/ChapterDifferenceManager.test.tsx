import { Button } from "@mantine/core";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../strings/languages/en/app.json";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  mutationPending: false,
  sheetProps: null as null | { busy?: boolean; onClose?: () => void },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueriesData: vi.fn(), invalidateQueries: vi.fn() }),
  useMutation: () => ({
    isPending: mocks.mutationPending,
    error: null,
    data: undefined,
    mutate: mocks.apply,
    reset: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useTranslation: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) => {
      let text = (en as Record<string, string>)[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
  }),
}));

vi.mock("../ui/ResponsiveSheet", () => ({
  ResponsiveSheet: (props: { busy?: boolean; onClose?: () => void; children?: ReactNode }) => {
    mocks.sheetProps = { busy: props.busy, onClose: props.onClose };
    return <section>{props.children}</section>;
  },
}));

import {
  collectElements,
  mountBackNavigationHarness,
  type BackNavigationHarness,
} from "../../lib/android-back-navigation.test-support";
import { ChapterDifferenceManager } from "./ChapterDifferenceManager";

let harness: BackNavigationHarness | undefined;
let rendered: ReactNode;

function Probe({
  refreshing,
  onClose,
  onCancelScan,
  scanProgress = { checked: 10, total: 50 },
}: {
  refreshing: boolean;
  onClose: () => void;
  onCancelScan: () => void;
  scanProgress?: { checked: number; total: number };
}) {
  rendered = ChapterDifferenceManager({
    novelId: 1,
    source: { serverUrl: "https://server.test", workId: "work-1" },
    differences: [],
    onClose,
    onRefresh: vi.fn(),
    onCancelScan,
    refreshing,
    scanProgress,
    scanErrors: 0,
    scanError: null,
  });
  return null;
}

afterEach(async () => {
  await harness?.unmount();
  harness = undefined;
  mocks.mutationPending = false;
  mocks.sheetProps = null;
});

describe("ChapterDifferenceManager", () => {
  it("allows cancelling and going back while a comparison scan is running", async () => {
    const onClose = vi.fn();
    const onCancelScan = vi.fn();
    harness = mountBackNavigationHarness();
    await harness.render(
      <Probe refreshing onClose={onClose} onCancelScan={onCancelScan} />,
    );

    const sheet = rendered as { props?: { busy?: boolean; onClose?: () => void } };
    // Sheet must stay dismissible (not busy-locked) while scanning so Back and Close work.
    expect(sheet.props?.busy).toBe(false);

    // Explicit Cancel button cancels the in-flight scan.
    const cancelButton = collectElements(rendered).find(
      (el) => el.type === Button && el.props.children === en["common.cancel"],
    )!;
    expect(cancelButton).toBeDefined();
    await harness.run(() => {
      (cancelButton.props.onClick as () => void)();
    });
    expect(onCancelScan).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // Closing the sheet (Close button / Android back / Escape) cancels the scan and navigates back.
    await harness.run(() => {
      sheet.props?.onClose?.();
    });
    expect(onCancelScan).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks dismissal only while file transfers are being applied", async () => {
    mocks.mutationPending = true;
    const onClose = vi.fn();
    const onCancelScan = vi.fn();
    harness = mountBackNavigationHarness();
    await harness.render(
      <Probe refreshing={false} onClose={onClose} onCancelScan={onCancelScan} />,
    );

    const sheet = rendered as { props?: { busy?: boolean; onClose?: () => void } };
    expect(sheet.props?.busy).toBe(true);
    await harness.run(() => {
      sheet.props?.onClose?.();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
