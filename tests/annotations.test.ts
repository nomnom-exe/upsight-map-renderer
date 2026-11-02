/**
 * @file tests/annotations.test.ts
 * @brief Test how nearby map annotations are grouped on screen.
 * @author Norman
 * @description Checks that each visible point is counted once and points outside the map are skipped.
 */

import { expect, it } from "vitest";
import { groupAnnotations } from "@upsight/map-renderer";

it("groups visible points by grid cell and skips points outside the map", () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i),
    x: i % 400,
    y: i % 300,
    count: 1,
  }));
  const groups = groupAnnotations(
    [...points, { id: "outside", x: -1, y: 30, count: 1 }],
    400,
    300,
  );
  expect(groups.length).toBeLessThanOrEqual(7 * 5);
  expect(groups.reduce((n, g) => n + g.count, 0)).toBe(5000);
  expect(groups.flatMap((g) => g.ids)).not.toContain("outside");
});
