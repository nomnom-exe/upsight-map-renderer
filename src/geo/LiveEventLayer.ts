/**
 * @file geo/LiveEventLayer.ts
 * @brief Display live map events until they expire. The host supplies the feed.
 * @author Norman
 */
import { SceneStore } from "./SceneStore.js";
import { DEFAULT_STYLE, type GeoFeature, type Geometry, type SourceInfo } from "./types.js";
import { finite, geometry, validateFeature } from "./validation.js";

export const MAX_LIVE_EVENTS = 2000;
const MAX_EVENT_VERTICES = 10000;
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;
// Only one layer runs the expiry timer for each source in a scene.
// The weak map lets discarded scenes be garbage collected.
const owners = new WeakMap<SceneStore, Set<string>>();
export interface ReportedRoadImpact {
  /** Use road IDs confirmed by the provider. A nearby road alone is insufficient. */
  readonly basis: "provider-confirmed";
  readonly roadIds: readonly string[];
  readonly direction: "forward" | "backward" | "both";
  readonly kind: "closure" | "delay";
  readonly delaySeconds?: number;
}
export interface LiveMapEvent {
  readonly id: string;
  readonly kind: "accident" | "slow-traffic" | "closure" | "road-work" | "advisory";
  readonly label: string;
  readonly message: string;
  readonly geometry: Extract<Geometry, { type: "Point" | "LineString" }>;
  /** An event expires at the earlier of its own end time and the feed's end time. */
  readonly expiresAt?: string;
  readonly impact?: ReportedRoadImpact;
  /** Known road height in metres above or below the scene's reference level. Omit when unknown. */
  readonly elevation?: number;
}
export interface LiveEventSnapshotV1 {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly events: readonly LiveMapEvent[];
  readonly truncated?: boolean;
}
export interface LiveEventState {
  readonly source: SourceInfo;
  readonly events: readonly LiveMapEvent[];
  readonly truncated: boolean;
}
const COLORS: Record<LiveMapEvent["kind"], string> = {
  accident: "#a93c32", "slow-traffic": "#b57822", closure: "#a93c32",
  "road-work": "#9c662b", advisory: "#476b86",
};
const timestamp = (value: string) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid live observation timestamp.");
  return Date.parse(value);
};
function eventFeature(source: string, event: LiveMapEvent): GeoFeature {
  const point = event.geometry.type === "Point";
  return validateFeature({
    id: `${source}:${event.id}`, source, layer: "custom:traffic", label: event.label,
    geometry: event.geometry,
    model: point ? { kind: "label", fontSize: 13 } : { kind: "line", line: { dashed: event.elevation === undefined } },
    style: { ...DEFAULT_STYLE, color: COLORS[event.kind], height: 0, width: 2.5, elevation: event.elevation ?? 0.35 },
    // Keep timestamps in the live state so refreshing an unchanged event can reuse its geometry.
    properties: { eventId: event.id, eventKind: event.kind, message: event.message,
      elevationBasis: event.elevation === undefined ? "unmatched-display-overlay" : "provider",
      routingImpact: event.impact?.kind ?? "advisory" },
  });
}

/** The host supplies snapshots over any transport. The layer removes expired events. */
export class LiveEventLayer {
  private observed = -Infinity;
  private expires = 0;
  private records: readonly { event: LiveMapEvent; feature: GeoFeature; expires: number }[] = [];
  private source: SourceInfo;
  private truncated = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(state: LiveEventState) => void>();
  constructor(private store: SceneStore, source: Pick<SourceInfo, "id" | "label" | "attribution">) {
    if (!source || !/^[\w.-]{1,60}$/.test(source.id) || typeof source.label !== "string" ||
        !source.label.trim() || source.label.length > 160 || typeof source.attribution !== "string" || source.attribution.length > 2000)
      throw new Error("Invalid live source metadata.");
    if (owners.get(store)?.has(source.id)) throw new Error("This live source already has an active layer.");
    store.protectSource(source.id);
    const sources = owners.get(store) ?? new Set<string>();
    sources.add(source.id);
    owners.set(store, sources);
    this.source = { ...source, status: "stale" };
  }
  /** Returns false for an older or equal timestamp. An invalid snapshot leaves the scene unchanged. */
  apply(snapshot: LiveEventSnapshotV1) {
    if (this.disposed) throw new Error("Live source has been disposed.");
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.events) ||
        snapshot.events.length > MAX_LIVE_EVENTS || (snapshot.truncated !== undefined && typeof snapshot.truncated !== "boolean"))
      throw new Error("Expected a bounded v1 live snapshot.");
    const observed = timestamp(snapshot.observedAt), expires = timestamp(snapshot.expiresAt), now = Date.now();
    if (observed > now + 60000 || expires <= observed || expires - observed > MAX_FRESHNESS_MS)
      throw new Error("Invalid live observation freshness window.");
    if (observed <= this.observed) return false;
    let vertices = 0;
    const ids = new Set<string>();
    const records = snapshot.events.map(event => {
      if (!event || typeof event.id !== "string" || !/^[\w%.-]{1,80}$/.test(event.id) || ids.has(event.id) ||
          !Object.prototype.hasOwnProperty.call(COLORS, event.kind) || typeof event.label !== "string" || !event.label.trim() || event.label.length > 160 ||
          typeof event.message !== "string" || event.message.length > 500 || !["Point", "LineString"].includes(event.geometry?.type))
        throw new Error("Invalid live event.");
      ids.add(event.id);
      const shape = geometry(event.geometry) as LiveMapEvent["geometry"];
      vertices += shape.type === "Point" ? 1 : shape.coordinates.length;
      if (vertices > MAX_EVENT_VERTICES) throw new Error("Live event geometry budget exceeded.");
      if (event.elevation !== undefined) finite(event.elevation, -1000, 1000);
      const eventExpires = event.expiresAt === undefined ? expires : Math.min(expires, timestamp(event.expiresAt));
      let impact: ReportedRoadImpact | undefined;
      if (event.impact) {
        const value = event.impact;
        if (value.basis !== "provider-confirmed" || !["closure", "delay"].includes(value.kind) ||
            !["forward", "backward", "both"].includes(value.direction) || !Array.isArray(value.roadIds) ||
            !value.roadIds.length || value.roadIds.length > 100 || new Set(value.roadIds).size !== value.roadIds.length ||
            value.roadIds.some((id: unknown) => typeof id !== "string" || !/^[\w:.-]{1,120}$/.test(id)))
          throw new Error("Routing impacts require explicit provider road assignments.");
        if (value.kind === "delay") finite(value.delaySeconds, 0, 86400);
        else if (value.delaySeconds !== undefined) throw new Error("A closure must not invent a delay duration.");
        impact = Object.freeze({ basis: value.basis, kind: value.kind, direction: value.direction,
          roadIds: Object.freeze([...value.roadIds]), ...(value.kind === "delay" ? { delaySeconds: value.delaySeconds } : {}) });
      }
      const normalized: LiveMapEvent = Object.freeze({ id: event.id, kind: event.kind, label: event.label,
        message: event.message, geometry: shape,
        ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
        ...(event.elevation !== undefined ? { elevation: event.elevation } : {}), ...(impact ? { impact } : {}) });
      return { event: normalized, feature: eventFeature(this.source.id, normalized), expires: eventExpires };
    }).filter(record => record.expires > now);
    const source = { ...this.source, status: expires > now ? "live" as const : "stale" as const, asOf: new Date(observed).toISOString() };
    this.store.replaceSource(source, records.map(record => record.feature));
    this.observed = observed;
    this.expires = expires;
    this.records = records;
    this.source = source;
    this.truncated = snapshot.truncated ?? false;
    this.notify();
    this.schedule();
    return true;
  }
  events() { return this.records.map(record => record.event); }
  getState(): LiveEventState { return { source: { ...this.source }, events: this.events(), truncated: this.truncated }; }
  subscribe(listener: (state: LiveEventState) => void) {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); } catch (error) { console.error("Live event observer failed", error); }
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.disposed || this.source.status !== "live") return;
    const next = Math.min(this.expires, ...this.records.map(record => record.expires));
    this.timer = setTimeout(() => {
      const now = Date.now();
      this.records = this.records.filter(record => record.expires > now);
      this.source = { ...this.source, status: this.expires > now ? "live" : "stale" };
      this.store.replaceSource(this.source, this.records.map(record => record.feature));
      this.notify();
      this.schedule();
    }, Math.max(1, next - Date.now()));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.records = [];
    try {
      if (Number.isFinite(this.observed)) this.store.replaceSource({ ...this.source, status: "stale" }, []);
    } finally {
      const sources = owners.get(this.store);
      sources?.delete(this.source.id);
      if (!sources?.size) owners.delete(this.store);
      this.listeners.clear();
    }
  }
}
