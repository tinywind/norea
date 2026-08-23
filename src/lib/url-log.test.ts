import { describe, expect, it } from "vitest";
import { redactUrlForLog, redactUrlsForLog } from "./url-log";

describe("URL log redaction", () => {
  it("keeps only an HTTP origin without credentials or URL secrets", () => {
    expect(
      redactUrlForLog(
        "https://user:password@source.test:8443/signed/path-token?token=secret#proof",
      ),
    ).toBe("https://source.test:8443");
  });

  it("redacts every HTTP URL embedded in an error message", () => {
    const result = redactUrlsForLog(
      "request https://source.test/signed-path-one?token=first#proof failed via http://user:pass@fallback.test/signed-path-two?token=second",
    );

    expect(result).toBe(
      "request https://source.test failed via http://fallback.test",
    );
  });

  it("removes query and fragment data from malformed values", () => {
    expect(redactUrlForLog("not a url?token=secret#proof")).toBe(
      "not a url",
    );
    expect(redactUrlForLog("https://%zz/signed-path?token=secret")).toBe(
      "<http-url>",
    );
  });
});
