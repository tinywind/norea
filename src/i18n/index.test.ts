import { describe, expect, it } from "vitest";
import { formatPluginLanguageForLocale, translate } from "./index";

const koreanNames = new Intl.DisplayNames(["ko"], { type: "language" });

describe("plugin language labels", () => {
  it("localizes the English language names plugin catalogs use", () => {
    expect(formatPluginLanguageForLocale("ko", "English")).toBe(koreanNames.of("en"));
    expect(formatPluginLanguageForLocale("ko", "Japanese")).toBe(koreanNames.of("ja"));
    expect(formatPluginLanguageForLocale("en", "Japanese")).toBe("Japanese");
  });

  it("translates Multi in any letter case", () => {
    expect(formatPluginLanguageForLocale("ko", "Multi")).toBe(translate("ko", "pluginLanguage.multi"));
    expect(formatPluginLanguageForLocale("en", "multi")).toBe("Multi");
  });

  it("keeps native names and unknown names, and still resolves language codes", () => {
    const nativeKorean = koreanNames.of("ko")!;
    expect(formatPluginLanguageForLocale("en", nativeKorean)).toBe(nativeKorean);
    expect(formatPluginLanguageForLocale("ko", "ko")).toBe(nativeKorean);
    expect(formatPluginLanguageForLocale("ko", "Klingonese")).toBe("Klingonese");
  });
});
