import { describe, expect, it } from "vitest";
import { PluginSandboxError, loadPlugin } from "./sandbox";

describe("loadPlugin", () => {
  it("returns the default export from a CommonJS plugin", () => {
    const source = `
      module.exports.default = {
        id: "test-plugin",
        name: "Test",
        version: "1.0.0",
      };
    `;
    const plugin = loadPlugin(source);
    expect(plugin).toMatchObject({
      id: "test-plugin",
      name: "Test",
      version: "1.0.0",
    });
  });

  it("throws PluginSandboxError when no default export is set", () => {
    expect(() => loadPlugin("module.exports = { id: 'test' };")).toThrow(
      PluginSandboxError,
    );
  });

  it("throws PluginSandboxError on a syntax error", () => {
    expect(() => loadPlugin("const x = ;")).toThrow(PluginSandboxError);
  });

  it("forwards required modules through resolveRequire", () => {
    const source = `
      const helper = require("@libs/test-helper");
      module.exports.default = { id: helper.id() };
    `;
    const plugin = loadPlugin(source, {
      resolveRequire: (id) => {
        if (id === "@libs/test-helper") {
          return { id: () => "resolved-id" };
        }
        throw new Error(`unexpected require: ${id}`);
      },
    });
    expect(plugin.id).toBe("resolved-id");
  });

  it("default resolveRequire rejects every module id", () => {
    const source = `require("anything"); module.exports.default = {};`;
    expect(() => loadPlugin(source)).toThrow(PluginSandboxError);
  });

  it("supports the TS-compiled `exports.default = ...` pattern", () => {
    const source = `
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.default = { id: "ts-plugin", name: "TS", version: "1" };
    `;
    const plugin = loadPlugin(source);
    expect(plugin.id).toBe("ts-plugin");
  });

  it("includes the underlying cause in the error message", () => {
    const source = `throw new Error("boom inside plugin");`;
    try {
      loadPlugin(source);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSandboxError);
      expect((error as Error).message).toContain("boom inside plugin");
    }
  });
});
