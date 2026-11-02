/**
 * @file src/engine/annotations.ts
 * @brief Group nearby map labels on the screen.
 * @author Norman
 * @description Group labels by grid cell so a crowded area can display one count.
 */

export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
  count: number;
}
export interface AnnotationGroup {
  ids: string[];
  x: number;
  y: number;
  count: number;
}
/** Points outside the view are skipped. Each visible cell gets one group. */
export function groupAnnotations(
  points: readonly ScreenPoint[],
  width: number,
  height: number,
  cell = 64,
): AnnotationGroup[] {
  const groups = new Map<string, AnnotationGroup>();
  for (const p of points) {
    if (
      ![p.x, p.y].every(Number.isFinite) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x > width ||
      p.y > height
    )
      continue;
    const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
    const g = groups.get(key);
    if (g) {
      const n = g.ids.length;
      g.x = (g.x * n + p.x) / (n + 1);
      g.y = (g.y * n + p.y) / (n + 1);
      g.ids.push(p.id);
      g.count += p.count;
    } else groups.set(key, { ids: [p.id], x: p.x, y: p.y, count: p.count });
  }
  return [...groups.values()];
}
