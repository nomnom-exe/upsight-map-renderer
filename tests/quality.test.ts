/**
 * @file tests/quality.test.ts
 * @brief Test rendering limits and changes in model detail.
 * @author Norman
 * @description Checks phone rendering limits and that small zoom changes near a threshold keep the current level of detail.
 */

import { expect, it } from "vitest";
import { batchDetail, qualityForDevice } from "@upsight/map-renderer/rendering/quality";

const mobile = qualityForDevice({ width: 390, dpr: 3, coarse: true, cores: 8 });
const standard = qualityForDevice({ width: 1440, dpr: 2, coarse: false, cores: 8 });
it("bounds phone raster workload without relying on a user agent string", () => {
  expect(mobile.pixelRatio).toBe(1.5);
  expect((mobile.pixelRatio / 3) ** 2).toBe(0.25);
  expect(mobile.maxVisible).toBeLessThan(standard.maxVisible);
  expect(qualityForDevice({ width: 1200, dpr: 2, coarse: false, memoryGB: 2 }).name).toBe("mobile");
});
it("keeps nearby detail stable at boundaries, while reducing distant decoration", () => {
  const bounds = { west: 103.85, east: 103.86, south: 1.28, north: 1.29 };
  expect(batchDetail(bounds, [103.855, 1.285], 15.8, mobile)).toBe(0);
  expect(batchDetail(bounds, [103.855, 1.285], 16.3, mobile)).toBe(1);
  expect(batchDetail(bounds, [103.855, 1.285], 16, mobile, 1)).toBe(1);
  expect(batchDetail(bounds, [103.9, 1.3], 18, mobile, 1)).toBe(0);
});
