import { describe, expect, it } from "vitest";
import {
  completedOverrideOf, isNovelCompleted, mergeWorkOverride, parseWorkOverride, sameWorkOverrideFields, type WorkOverrideV1,
} from "./override";

const identity = { pluginId: "plugin", novelId: "work", novelPath: "/work" };
const document = (fields: WorkOverrideV1["fields"]): WorkOverrideV1 => ({ schemaVersion: 1, identity, fields });

describe("parseWorkOverride", () => {
  it("keeps valid fields, including names this version does not know", () => {
    const parsed = parseWorkOverride({
      schemaVersion: 1, identity: { ...identity, extra: true },
      fields: { title: { value: "Mine", updatedAt: 5 }, completed: { value: null, updatedAt: 9 } },
    });
    expect(parsed).toEqual(document({ completed: { value: null, updatedAt: 9 }, title: { value: "Mine", updatedAt: 5 } }));
    expect(Object.keys(parsed.fields)).toEqual(["completed", "title"]);
  });

  it.each([
    ["another schema version", { schemaVersion: 2, identity, fields: {} }],
    ["an empty identity value", { schemaVersion: 1, identity: { ...identity, novelId: "" }, fields: {} }],
    ["a non-boolean completion", { schemaVersion: 1, identity, fields: { completed: { value: "yes", updatedAt: 1 } } }],
    ["a missing edit time", { schemaVersion: 1, identity, fields: { completed: { value: true } } }],
    ["an extra entry key", { schemaVersion: 1, identity, fields: { completed: { value: true, updatedAt: 1, by: "a" } } }],
    ["an invalid field name", { schemaVersion: 1, identity, fields: { "Bad-Name": { value: true, updatedAt: 1 } } }],
    ["an object value", { schemaVersion: 1, identity, fields: { note: { value: {}, updatedAt: 1 } } }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseWorkOverride(value)).toThrow();
  });
});

describe("mergeWorkOverride", () => {
  it("takes the strictly newer edit per field, keeps the base on a tie and uses the given identity", () => {
    const base = document({ completed: { value: true, updatedAt: 10 }, title: { value: "Base", updatedAt: 5 } });
    const incoming: WorkOverrideV1 = {
      schemaVersion: 1, identity: { pluginId: "other", novelId: "x", novelPath: "/x" },
      fields: { completed: { value: false, updatedAt: 10 }, title: { value: "Newer", updatedAt: 6 }, author: { value: "A", updatedAt: 1 } },
    };
    expect(mergeWorkOverride(base, incoming, identity)).toEqual(document({
      author: { value: "A", updatedAt: 1 }, completed: { value: true, updatedAt: 10 }, title: { value: "Newer", updatedAt: 6 },
    }));
  });

  it("carries a cleared field so the clearing reaches other devices", () => {
    const merged = mergeWorkOverride(document({ completed: { value: true, updatedAt: 1 } }), document({ completed: { value: null, updatedAt: 2 } }), identity);
    expect(merged.fields.completed).toEqual({ value: null, updatedAt: 2 });
    expect(completedOverrideOf(merged)).toBeNull();
    expect(mergeWorkOverride(null, null, identity)).toEqual(document({}));
  });
});

it("compares override fields by value and edit time", () => {
  const left = document({ completed: { value: true, updatedAt: 1 } });
  expect(sameWorkOverrideFields(left, document({ completed: { value: true, updatedAt: 1 } }))).toBe(true);
  expect(sameWorkOverrideFields(left, document({ completed: { value: true, updatedAt: 2 } }))).toBe(false);
  expect(sameWorkOverrideFields(left, null)).toBe(false);
  expect(sameWorkOverrideFields(null, document({}))).toBe(true);
});

it.each([
  [{ status: "Completed" }, true],
  [{ status: "완결" }, true],
  [{ status: "Publishing Finished" }, true],
  [{ status: "Ongoing" }, false],
  [{ status: null }, false],
  [{ status: "Ongoing", completedOverride: true }, true],
  [{ status: "Completed", completedOverride: false }, false],
  [{ status: "Completed", completedOverride: null }, true],
])("decides completion for %j", (novel, completed) => {
  expect(isNovelCompleted(novel)).toBe(completed);
});
