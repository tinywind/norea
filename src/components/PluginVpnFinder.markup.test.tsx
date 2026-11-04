import { MantineProvider } from "@mantine/core";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginVpnFinderLoadFailureNotice } from "./PluginVpnFinder";

const mocks = vi.hoisted(() => ({ locale: "en" as "en" | "ko" }));
vi.mock("../i18n", async (original) => {
  const actual = await original<typeof import("../i18n")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: mocks.locale,
      t: (
        key: Parameters<typeof actual.translate>[1],
        values?: Parameters<typeof actual.translate>[2],
      ) => actual.translate(mocks.locale, key, values),
    }),
  };
});

const TIMEOUT_DETAIL =
  "could not load the VPN Gate server list: VPN Gate server list request timed out.";

function renderNotice(detail: string | null) {
  return load(
    renderToStaticMarkup(
      <MantineProvider>
        <PluginVpnFinderLoadFailureNotice detail={detail} />
      </MantineProvider>,
    ),
  );
}

describe("PluginVpnFinderLoadFailureNotice", () => {
  afterEach(() => {
    mocks.locale = "en";
  });

  it("shows Korean advice and keeps the raw error collapsed under details", () => {
    mocks.locale = "ko";

    const $ = renderNotice(TIMEOUT_DETAIL);

    expect($('[role="alert"]').text()).toBe(
      "VPN Gate 서버를 불러오지 못했습니다. VPN Gate에 연결하지 못했거나 응답이 너무 늦습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.",
    );
    expect($('[role="alert"]').text()).not.toContain("timed out");
    expect($("details.norea-state-details summary").text()).toBe("세부 정보");
    expect($("details.norea-state-details").attr("open")).toBeUndefined();
    expect($("details.norea-state-details > div").text()).toBe(TIMEOUT_DETAIL);
  });

  it("explains an unusable server list and omits empty details", () => {
    const $ = renderNotice(null);
    expect($('[role="alert"]').text()).toContain("Check your internet connection");
    expect($("details").length).toBe(0);

    const invalid = renderNotice("VPN Gate server list marker is invalid");
    expect(invalid('[role="alert"]').text()).toBe(
      "Could not load VPN Gate servers. VPN Gate did not send a usable server list. Try again later.",
    );
  });
});
