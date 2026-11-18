import { describe, expect, it } from "vitest";
import {
  coverOverrideOf, isNovelCompleted, mergeWorkOverride, parseWorkOverride, sameWorkOverrideFields, statusOverrideOf, type WorkOverrideV1,
} from "./override";

const identity = { pluginId: "plugin", novelId: "work", novelPath: "/work" };
const document = (fields: WorkOverrideV1["fields"]): WorkOverrideV1 => ({ schemaVersion: 1, identity, fields });

describe("parseWorkOverride", () => {
  it("keeps valid fields, upgrades legacy completed to status, and preserves unknown fields", () => {
    const parsed = parseWorkOverride({
      schemaVersion: 1, identity: { ...identity, extra: true },
      fields: {
        title: { value: "Mine", updatedAt: 5 },
        completed: { value: true, updatedAt: 9 },
        cover: { value: "cover.override.png", updatedAt: 10 },
        name: { value: "  Renamed  ", updatedAt: 11 },
      },
    });
    expect(parsed).toEqual(document({
      cover: { value: "cover.override.png", updatedAt: 10 },
      name: { value: "Renamed", updatedAt: 11 },
      status: { value: "Completed", updatedAt: 9 },
      title: { value: "Mine", updatedAt: 5 },
    }));
    expect(Object.keys(parsed.fields)).toEqual(["cover", "name", "status", "title"]);
    expect(statusOverrideOf(parsed)).toBe("Completed");
    expect(coverOverrideOf(parsed)).toBe("cover.override.png");
  });

  it.each([
    ["another schema version", { schemaVersion: 2, identity, fields: {} }],
    ["an empty identity value", { schemaVersion: 1, identity: { ...identity, novelId: "" }, fields: {} }],
    ["a non-boolean completion", { schemaVersion: 1, identity, fields: { completed: { value: "yes", updatedAt: 1 } } }],
    ["an invalid status constant", { schemaVersion: 1, identity, fields: { status: { value: "Done", updatedAt: 1 } } }],
    ["an invalid override cover filename", { schemaVersion: 1, identity, fields: { cover: { value: "cover.png", updatedAt: 1 } } }],
    ["a blank override name", { schemaVersion: 1, identity, fields: { name: { value: "   ", updatedAt: 1 } } }],
    ["a missing edit time", { schemaVersion: 1, identity, fields: { status: { value: "Completed" } } }],
    ["an extra entry key", { schemaVersion: 1, identity, fields: { status: { value: "Completed", updatedAt: 1, by: "a" } } }],
    ["an invalid field name", { schemaVersion: 1, identity, fields: { "Bad-Name": { value: true, updatedAt: 1 } } }],
    ["an object value", { schemaVersion: 1, identity, fields: { note: { value: {}, updatedAt: 1 } } }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseWorkOverride(value)).toThrow();
  });
});

describe("mergeWorkOverride", () => {
  it("takes the strictly newer edit per field, keeps the base on a tie and uses the given identity", () => {
    const base = document({ status: { value: "Completed", updatedAt: 10 }, title: { value: "Base", updatedAt: 5 } });
    const incoming: WorkOverrideV1 = {
      schemaVersion: 1, identity: { pluginId: "other", novelId: "x", novelPath: "/x" },
      fields: { status: { value: "Ongoing", updatedAt: 10 }, title: { value: "Newer", updatedAt: 6 }, author: { value: "A", updatedAt: 1 } },
    };
    expect(mergeWorkOverride(base, incoming, identity)).toEqual(document({
      author: { value: "A", updatedAt: 1 }, status: { value: "Completed", updatedAt: 10 }, title: { value: "Newer", updatedAt: 6 },
    }));
  });

  it("carries a cleared field so the clearing reaches other devices", () => {
    const merged = mergeWorkOverride(document({ status: { value: "Completed", updatedAt: 1 } }), document({ status: { value: null, updatedAt: 2 } }), identity);
    expect(merged.fields.status).toEqual({ value: null, updatedAt: 2 });
    expect(statusOverrideOf(merged)).toBeNull();
    expect(mergeWorkOverride(null, null, identity)).toEqual(document({}));
  });
});

it("compares override fields by value and edit time", () => {
  const left = document({ status: { value: "Completed", updatedAt: 1 } });
  expect(sameWorkOverrideFields(left, document({ status: { value: "Completed", updatedAt: 1 } }))).toBe(true);
  expect(sameWorkOverrideFields(left, document({ status: { value: "Completed", updatedAt: 2 } }))).toBe(false);
  expect(sameWorkOverrideFields(left, null)).toBe(false);
  expect(sameWorkOverrideFields(null, document({}))).toBe(true);
});

it.each([
  [{ status: "Completed" }, true],
  [{ status: "완결" }, false],
  [{ status: "completed" }, false],
  [{ status: "Publishing Finished" }, false],
  [{ status: "Ongoing" }, false],
  [{ status: null }, false],
  [{ status: "Ongoing", statusOverride: "Completed" }, true],
  [{ status: "Completed", statusOverride: "Ongoing" }, false],
  [{ status: "Completed", statusOverride: null }, true],
])("decides completion for %j", (novel, completed) => {
  expect(isNovelCompleted(novel)).toBe(completed);
});
