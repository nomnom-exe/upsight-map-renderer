/**
 * @file src/geo/hash.ts
 * @brief Generate repeatable patterns for map details.
 * @author Norman
 * @description The same string gives the same numeric seed.
 */

/** FNV-1a can give different strings the same seed. Use it for decoration only. */
export function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}
