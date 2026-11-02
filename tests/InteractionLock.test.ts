/**
 * @file tests/InteractionLock.test.ts
 * @brief Test map controls when editing gestures overlap.
 * @author Norman
 * @description Checks that releasing a gesture twice is safe and that controls disabled before editing stay disabled after cleanup.
 */

import { expect, it, vi } from "vitest";
import { InteractionLock } from "@upsight/map-renderer/rendering/InteractionLock";
it("releases nested editor gestures once, preserving disabled controls and surviving disposal", () => {
  const pan = { isEnabled: () => true, disable: vi.fn(), enable: vi.fn() },
    keyboard = { isEnabled: () => false, disable: vi.fn(), enable: vi.fn() };
  const lock = new InteractionLock([pan, keyboard]),
    a = lock.acquire(),
    b = lock.acquire();
  expect(pan.disable).toHaveBeenCalledTimes(1);
  expect(keyboard.disable).not.toHaveBeenCalled();
  a();
  a();
  expect(pan.enable).not.toHaveBeenCalled();
  b();
  expect(pan.enable).toHaveBeenCalledTimes(1);
  const c = lock.acquire();
  lock.dispose();
  c();
  lock.dispose();
  expect(pan.enable).toHaveBeenCalledTimes(2);
  expect(keyboard.enable).not.toHaveBeenCalled();
});
