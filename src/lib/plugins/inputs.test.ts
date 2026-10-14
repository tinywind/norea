import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPluginInputValues,
  getPluginInputValue,
  getPluginInputValues,
  setPluginInputValue,
} from "./inputs";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      key(index: number) {
        return [...values.keys()][index] ?? null;
      },
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    } as Storage,
  });
});

describe("plugin storage namespaces", () => {
  it("ignores values stored in the obsolete namespace", () => {
    values.set("plugin:komga:alpha:token", "alpha-token");
    values.set("plugin:komga:alpha:beta:token", "beta-token");

    expect(getPluginInputValue("komga:alpha", "token")).toBeNull();
    expect(getPluginInputValues("komga:alpha:beta")).toEqual({});
    expect(values.size).toBe(2);
  });

  it("isolates nested source ids when reading and clearing their values", () => {
    setPluginInputValue("komga:alpha", "token", "alpha-token");
    setPluginInputValue("komga:alpha:beta", "token", "beta-token");
    expect(getPluginInputValue("komga:alpha", "token")).toBe("alpha-token");
    expect(getPluginInputValue("komga:alpha:beta", "token")).toBe(
      "beta-token",
    );

    clearPluginInputValues("komga:alpha");

    expect(getPluginInputValue("komga:alpha", "token")).toBeNull();
    expect(getPluginInputValue("komga:alpha:beta", "token")).toBe(
      "beta-token",
    );
  });
});
