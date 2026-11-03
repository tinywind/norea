import { expect, it } from "vitest";
import type { LibrarySortOrder } from "../store/library";
import {
  getLibrarySortDirection,
  getLibrarySortField,
  LIBRARY_SORT_FIELDS,
  toLibrarySortOrder,
} from "./library-settings-options";

it("splits every stored sort order into a field and a direction and back", () => {
  const orders = LIBRARY_SORT_FIELDS.flatMap((field) =>
    (["asc", "desc"] as const).map((direction) => toLibrarySortOrder(field, direction)),
  );
  expect(new Set(orders).size).toBe(16);
  for (const order of orders) {
    expect(toLibrarySortOrder(getLibrarySortField(order), getLibrarySortDirection(order))).toBe(order);
  }
  const lastRead: LibrarySortOrder = "lastReadDesc";
  expect([getLibrarySortField(lastRead), getLibrarySortDirection(lastRead)]).toEqual(["lastRead", "desc"]);
});
