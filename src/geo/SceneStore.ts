/**
 * @file src/geo/SceneStore.ts
 * @brief Store provider features and user edits separately.
 * @author Norman
 * @description Apply edits, undo or redo them, and save or restore a scenario.
 */

import { transformFeature } from "./math.js";
import type {
  GeoFeature,
  SceneChange,
  SceneCommand,
  SourceInfo,
} from "./types.js";
import { validateFeature } from "./validation.js";
import {
  buildingIdentity,
  buildingSelection,
  transformBuilding,
} from "./buildingGroups.js";

type Overrides = Map<string, GeoFeature | null>;
/** Verified part IDs saved when the user edited the whole building. */
export interface BuildingSnapshotPin {
  readonly source: string;
  readonly groupId: string;
  readonly memberIds: readonly string[];
}
export interface BuildingRefreshConflict {
  readonly reason: "membership-changed";
  readonly source: string;
  readonly groupId: string;
  readonly savedMemberIds: readonly string[];
  readonly incomingMemberIds: readonly string[];
  /** False when the loaded source data lacks a complete group of building parts. */
  readonly incomingComplete: boolean;
}
/** Each drag update starts from the original selection. Committing a change adds one undo step. */
export interface SelectionPreview {
  move(east: number, north: number): void;
  /** Move east and north in metres, rotate in degrees and scale uniformly from the start of the drag. */
  transform(east: number, north: number, angle?: number, scale?: number): void;
  finish(commit: boolean): void;
}
type Pins = Map<string, BuildingSnapshotPin>;
type ScenarioState = { overrides: Overrides; pins: Pins };
export type ScenarioPartition = (id: string, feature: GeoFeature | null) => boolean;
const pinKey = (pin: BuildingSnapshotPin) => `${pin.source}:${pin.groupId}`;
const MAX_SCENARIO_LENGTH = 2_000_000;
/** Use the same scenario format for exported files and separately stored groups of edits. */
export function serializeScenario(
  overrides: ReadonlyArray<readonly [string, GeoFeature | null]>,
  pins: readonly BuildingSnapshotPin[],
) {
  const text = JSON.stringify({ version: 1, overrides, ...(pins.length ? { buildingPins: pins } : {}) });
  if (text.length > MAX_SCENARIO_LENGTH) throw new Error("Scenario exceeds 2 MB.");
  return text;
}
/** Compare records without serializing them. As in JSON, ignore undefined object fields and preserve array order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++)
      if (!sameValue(a[i] ?? null, b[i] ?? null)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  let leftCount = 0, rightCount = 0;
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue;
    leftCount++;
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameValue(left[key], right[key])) return false;
  }
  for (const key of Object.keys(right)) if (right[key] !== undefined) rightCount++;
  return leftCount === rightCount;
}
/** Provider refreshes and saved scenario edits can be applied independently. */
export class SceneStore {
  private readonly readOnlyIds: Set<string>;
  private readonly readOnlySources = new Set<string>();
  /** The host can refresh read-only features through replaceSource. Scenario edits cannot change them. */
  constructor(
    private options: {
      readOnlyIds?: readonly string[];
      /** Reserve these source IDs before loading saved edits. */
      readOnlySources?: readonly string[];
      resolveOverride?: (
        base: GeoFeature | undefined,
        override: GeoFeature,
      ) => GeoFeature | null;
      validateOverrides?: (
        entries: ReadonlyArray<readonly [string, GeoFeature | null]>,
      ) => void;
    } = {},
  ) {
    this.readOnlyIds = new Set(options.readOnlyIds);
    for (const source of options.readOnlySources ?? []) this.protectSource(source);
  }
  isEditable(id: string) {
    const source = this.base.get(id)?.source ?? this.records.get(id)?.source;
    return !this.readOnlyIds.has(id) && !this.protectedSource(id, source);
  }
  private protectedSource(id: string, source?: string) {
    return (source !== undefined && this.readOnlySources.has(source)) ||
      [...this.readOnlySources].some(value => id.startsWith(`${value}:`));
  }
  /** Reserve the source ID for the life of the store. Reject conflicts with current edits, undo or redo. */
  protectSource(source: string) {
    if (!/^[\w.-]{1,60}$/.test(source)) throw new Error("Invalid protected source ID.");
    if (this.readOnlySources.has(source)) return;
    const conflicts = ({ overrides, pins }: ScenarioState) =>
      [...pins.values()].some(pin => pin.source === source) ||
      [...overrides].some(([id, feature]) => id.startsWith(`${source}:`) ||
        feature?.source === source || this.base.get(id)?.source === source);
    if (conflicts({ overrides: this.overrides, pins: this.pins }) ||
        this.past.some(conflicts) || this.future.some(conflicts))
      throw new Error("This provider namespace already has scenario edits. Reset those edits before attaching the live source.");
    this.readOnlySources.add(source);
    for (const f of this.base.values())
      if (f.source === source && !f.id.startsWith(`${source}:`)) this.readOnlyIds.add(f.id);
    if (this.preview?.features.some(f => !this.isEditable(f.id) || this.protectedSource(f.id, f.source)))
      this.cancelPreview();
  }
  private preview: { token: symbol; features: readonly GeoFeature[] } | null =
    null;
  private groups = new Map<string, Set<string>>();
  private base = new Map<string, GeoFeature>();
  private overrides: Overrides = new Map();
  private pins: Pins = new Map();
  private records = new Map<string, GeoFeature>();
  private sources = new Map<string, SourceInfo>();
  private listeners = new Set<(event: SceneChange) => void>();
  private past: ScenarioState[] = [];
  private future: ScenarioState[] = [];
  // Cache vertex counts for as long as each frozen feature is in use.
  private vertexCounts = new WeakMap<GeoFeature, number>();
  private equal(a: GeoFeature | undefined, b: GeoFeature | undefined) {
    return sameValue(a, b);
  }
  private vertexCount(feature: GeoFeature) {
    let count = this.vertexCounts.get(feature);
    if (count === undefined) {
      const g = feature.geometry;
      count = g.type === "Point" ? 1 : g.type === "LineString"
        ? g.coordinates.length
        : g.coordinates.reduce((sum, ring) => sum + ring.length, 0);
      this.vertexCounts.set(feature, count);
    }
    return count;
  }
  revision = 0;
  get size() {
    return this.records.size;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get(id: string) {
    return this.records.get(id);
  }
  building(id: string) {
    const f = this.get(id),
      key = f && buildingIdentity(f);
    const ids = key ? this.groups.get(key) : undefined;
    return ids?.size
      ? buildingSelection([...ids].map((id) => this.records.get(id)!))
      : undefined;
  }
  selectionMembers(id: string) {
    const f = this.get(id);
    return this.building(id)?.members ?? (f ? [f] : []);
  }
  canEditSelection(id: string) {
    const group = this.building(id);
    return (
      Boolean(this.get(id)) &&
      this.selectionMembers(id).every((f) => this.isEditable(f.id)) &&
      (!group || group.complete)
    );
  }
  requireSelection(id: string) {
    const members = this.selectionMembers(id);
    if (!members.length || !this.canEditSelection(id))
      throw new Error(
        "Load the complete building before editing. Zoom in and focus the building.",
      );
    return members;
  }
  transformSelection(
    id: string,
    east: number,
    north: number,
    angle = 0,
    scale = 1,
  ) {
    const members = this.requireSelection(id);
    return this.building(id)
      ? transformBuilding(members, east, north, angle, scale)
      : members.map((f) => transformFeature(f, east, north, angle, scale));
  }
  values() {
    return [...this.records.values()];
  }
  sourceInfo() {
    return [...this.sources.values()];
  }
  isOverridden(id: string) {
    return this.overrides.has(id);
  }
  subscribe(listener: (event: SceneChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Compare saved building parts with the parts reported by the current source. */
  buildingRefreshConflicts(): readonly BuildingRefreshConflict[] {
    const observed = new Map<string, GeoFeature[]>();
    for (const f of this.base.values()) {
      const key = buildingIdentity(f);
      if (!key || !this.pins.has(key)) continue;
      if (!observed.has(key)) observed.set(key, []);
      observed.get(key)!.push(f);
    }
    const conflicts: BuildingRefreshConflict[] = [];
    for (const [key, members] of observed) {
      const pin = this.pins.get(key)!;
      const incoming = buildingSelection(members);
      const savedIds = new Set(pin.memberIds);
      const sameIds = members.every((f) => savedIds.has(f.id));
      if (sameIds && incoming.expected === pin.memberIds.length &&
          (!incoming.complete || members.length === pin.memberIds.length)) continue;
      conflicts.push({ reason: "membership-changed", source: pin.source, groupId: pin.groupId,
        savedMemberIds: [...pin.memberIds], incomingMemberIds: members.map((f) => f.id).sort(),
        incomingComplete: incoming.complete });
    }
    return conflicts;
  }
  private compose(base: Map<string, GeoFeature>, overrides: Overrides, pins = this.pins, preview: readonly GeoFeature[] = []) {
    const records = new Map(base);
    // Hide newly reported parts at the building's old location. Keep them in the source data for undo or reset.
    if (pins.size) {
      const membership = new Map([...pins].map(([key, pin]) => [key, new Set(pin.memberIds)]));
      for (const [id, f] of records) {
        const key = buildingIdentity(f), members = key && membership.get(key);
        if (members && !members.has(id) && !this.readOnlyIds.has(id) && !this.protectedSource(id, f.source))
          records.delete(id);
      }
    }
    for (const [id, f] of overrides) {
      if (f) {
        const resolved = this.options.resolveOverride
          ? this.options.resolveOverride(base.get(id), f)
          : f;
        if (resolved) records.set(id, resolved);
        else records.delete(id);
      } else records.delete(id);
    }
    for (const f of preview) records.set(f.id, f);
    let vertices = 0;
    for (const f of records.values()) vertices += this.vertexCount(f);
    if (records.size > 25000 || vertices > 500000 || overrides.size > 10000)
      throw new Error("Scene budget: 25,000 features / 500,000 vertices.");
    return records;
  }
  private publish(
    next: Map<string, GeoFeature>,
    reason: SceneChange["reason"] = "source",
  ) {
    const ids = [...new Set([...this.records.keys(), ...next.keys()])].filter(
      (id) => {
        const previous = this.records.get(id),
          current = next.get(id);
        // Unchanged records share the same frozen object, so most comparisons finish immediately.
        return !this.equal(previous, current);
      },
    );
    for (const id of ids) {
      const previous = this.records.get(id),
        current = next.get(id);
      const before = previous && buildingIdentity(previous),
        after = current && buildingIdentity(current);
      if (before === after) continue;
      if (before) {
        const members = this.groups.get(before);
        members?.delete(id);
        if (!members?.size) this.groups.delete(before);
      }
      if (after) {
        if (!this.groups.has(after)) this.groups.set(after, new Set());
        this.groups.get(after)!.add(id);
      }
    }
    this.records = next;
    const event = { revision: ++this.revision, ids, reason };
    // Keep notifying other listeners if one throws.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Scene observer failed", error);
      }
    }
  }
  replaceSource(info: SourceInfo, features: readonly GeoFeature[]) {
    if (!/^[\w.-]{1,60}$/.test(info.id)) throw new Error("Invalid source ID.");
    const incoming = features.map((feature) => {
      const valid = validateFeature(feature), previous = this.base.get(valid.id);
      // Overlapping map requests can return copies of the same feature. Reuse unchanged objects so indexes skip them.
      return this.equal(previous, valid) ? previous! : valid;
    });
    if (
      new Set(incoming.map((f) => f.id)).size !== incoming.length ||
      incoming.some((f) => f.source !== info.id)
    )
      throw new Error("Source IDs must be unique and owned by the provider.");
    // The provider identifies which unprefixed IDs it owns. Reserve those IDs only after the update succeeds.
    const newlyProtected = new Set<string>();
    if (this.readOnlySources.has(info.id)) for (const f of incoming)
      if (!f.id.startsWith(`${info.id}:`) && !this.readOnlyIds.has(f.id)) newlyProtected.add(f.id);
    const endPreview = this.preview?.features.some(f => f.source === info.id ||
      this.base.get(f.id)?.source === info.id || newlyProtected.has(f.id));
    if (
      JSON.stringify(this.sources.get(info.id)) === JSON.stringify(info) &&
      incoming.every((f) => this.base.get(f.id) === f) &&
      [...this.base.values()].filter((f) => f.source === info.id).length === incoming.length
    ) {
      if (endPreview) this.cancelPreview();
      return;
    }
    const base = new Map(
      [...this.base].filter(([, f]) => f.source !== info.id),
    );
    for (const f of incoming) {
      if (base.has(f.id))
        throw new Error("Feature ID collides with another provider.");
      base.set(f.id, f);
    }
    const removeProtected = (state: ScenarioState): ScenarioState => {
      if (!newlyProtected.size) return state;
      return {
        overrides: new Map([...state.overrides].filter(([id]) => !newlyProtected.has(id))),
        pins: new Map([...state.pins].filter(([, pin]) => !pin.memberIds.some(id => newlyProtected.has(id)))),
      };
    };
    const state = removeProtected({ overrides: this.overrides, pins: this.pins });
    const next = this.compose(base, state.overrides, state.pins, endPreview ? [] : this.preview?.features);
    if (newlyProtected.size) {
      for (const id of newlyProtected) this.readOnlyIds.add(id);
      this.past = this.past.map(removeProtected);
      this.future = this.future.map(removeProtected);
      this.overrides = state.overrides;
      this.pins = state.pins;
    }
    if (endPreview) this.preview = null;
    this.base = base;
    this.sources.set(info.id, Object.freeze({ ...info }));
    this.publish(next);
  }
  /** Show drag updates immediately. Only committed edits enter history and exports. */
  beginPreview(id: string) {
    const preview = this.beginFeaturesPreview([id]);
    return {
      update: (feature: GeoFeature) => preview.update([feature]),
      finish: preview.finish,
    };
  }
  beginSelectionPreview(id: string): SelectionPreview {
    this.cancelPreview();
    const original = this.requireSelection(id),
      grouped = Boolean(this.building(id));
    const preview = this.beginFeaturesPreview(original.map((f) => f.id));
    const transform = (east: number, north: number, angle = 0, scale = 1) =>
      preview.update(
        grouped
          ? transformBuilding(original, east, north, angle, scale)
          : original.map((f) => transformFeature(f, east, north, angle, scale)),
      );
    return {
      move: (east: number, north: number) => transform(east, north),
      transform,
      finish: preview.finish,
    };
  }
  private beginFeaturesPreview(ids: readonly string[]) {
    this.cancelPreview();
    const original = ids.map((id) => this.get(id));
    if (original.some((f) => !f || !this.isEditable(f.id)))
      throw new Error("Object cannot be moved.");
    const token = Symbol(ids[0]);
    this.preview = { token, features: original as GeoFeature[] };
    return {
      update: (features: readonly GeoFeature[]) => {
        if (this.preview?.token !== token) return;
        if (
          features.length !== ids.length ||
          features.some((f, i) => f.id !== ids[i])
        )
          throw new Error("Preview must keep its object IDs.");
        const validated = features.map(validateFeature);
        if (validated.some(f => !this.isEditable(f.id) || this.protectedSource(f.id, f.source)))
          throw new Error("This feature is managed by its provider.");
        this.preview.features = validated;
        // Update the edited features without rebuilding the rest of the scene on each drag.
        const next = new Map(this.records);
        for (const f of validated) next.set(f.id, f);
        this.publish(next, "preview");
      },
      finish: (commit: boolean) => {
        if (this.preview?.token !== token) return;
        const final = this.preview.features;
        if (commit && !sameValue(original, final))
          this.execute({ type: "upsert", features: final });
        else this.cancelPreview();
      },
    };
  }
  private cancelPreview() {
    if (!this.preview) return;
    const records = this.compose(this.base, this.overrides);
    this.preview = null;
    this.publish(records, "preview");
  }
  execute(command: SceneCommand) {
    const committed = this.preview ? this.compose(this.base, this.overrides) : this.records;
    const next = new Map(this.overrides);
    if (command.type === "upsert") {
      const incoming = command.features.map(validateFeature);
      if (new Set(incoming.map((f) => f.id)).size !== incoming.length)
        throw new Error("Duplicate command ID.");
      for (const f of incoming) next.set(f.id, f);
    } else
      for (const id of command.ids) {
        if (!committed.has(id))
          throw new Error("Cannot remove unknown feature.");
        next.set(id, null);
      }
    const pins = new Map(this.pins);
    const changed = new Set(command.type === "upsert" ? command.features.map((f) => f.id) : command.ids);
    for (const id of changed) {
      const f = committed.get(id), key = f && buildingIdentity(f);
      if (!f || !key || pins.has(key)) continue;
      const group = this.preview
        ? buildingSelection([...committed.values()].filter(member => buildingIdentity(member) === key))
        : this.building(id);
      // Save building membership only when this edit includes every verified part.
      if (!group?.complete || !group.members.every((member) => changed.has(member.id))) continue;
      pins.set(key, Object.freeze({ source: f.source, groupId: String(f.properties.buildingGroup),
        memberIds: Object.freeze(group.members.map((member) => member.id).sort()) }));
    }
    this.commitOverrides(next, pins);
  }
  private commitOverrides(next: Overrides, pins: Pins, history = true) {
    this.options.validateOverrides?.([...next]);
    for (const pin of pins.values())
      if (this.readOnlySources.has(pin.source))
        throw new Error("Building snapshot is managed by its provider.");
    for (const [id, feature] of next) {
      if (this.readOnlyIds.has(id) || this.protectedSource(id, this.base.get(id)?.source) ||
          this.protectedSource(id, feature?.source))
        throw new Error(
          "This feature is managed by its provider and cannot be changed by a visual scenario.",
        );
    }
    const records = this.compose(this.base, next, pins);
    this.preview = null;
    if (history) this.past.push({ overrides: this.overrides, pins: this.pins });
    else this.past = [];
    if (this.past.length > 40) this.past.shift();
    this.future = [];
    this.overrides = next;
    this.pins = pins;
    this.publish(records, "commit");
  }
  undo() {
    const previous = this.past.at(-1);
    if (!previous) return this.cancelPreview();
    const records = this.compose(this.base, previous.overrides, previous.pins);
    this.preview = null;
    this.past.pop();
    this.future.push({ overrides: this.overrides, pins: this.pins });
    this.overrides = previous.overrides;
    this.pins = previous.pins;
    this.publish(records, "commit");
  }
  redo() {
    const next = this.future.at(-1);
    if (!next) return this.cancelPreview();
    const records = this.compose(this.base, next.overrides, next.pins);
    this.preview = null;
    this.future.pop();
    this.past.push({ overrides: this.overrides, pins: this.pins });
    this.overrides = next.overrides;
    this.pins = next.pins;
    this.publish(records, "commit");
  }
  clearScenario() {
    this.commitOverrides(new Map(), new Map());
  }
  committedOverrides(): ReadonlyArray<readonly [string, GeoFeature | null]> {
    return [...this.overrides];
  }
  committedBuildingPins(): readonly BuildingSnapshotPin[] {
    return [...this.pins.values()];
  }
  /** Keep every saved part of a building in the same storage partition. */
  partitionBuildingPins(include: ScenarioPartition): readonly BuildingSnapshotPin[] {
    return this.committedBuildingPins().filter(pin => {
      const included = pin.memberIds.map(id => include(id, this.overrides.get(id)!));
      if (included.some(Boolean) && !included.every(Boolean))
        throw new Error("A persistence partition cannot split a pinned building.");
      return included.every(Boolean);
    });
  }
  resetOverrides(ids: readonly string[]) {
    const next = new Map(this.overrides);
    const reset = new Set(ids), pins = new Map(this.pins);
    for (const [key, pin] of pins) {
      if (!pin.memberIds.some((id) => reset.has(id))) continue;
      pin.memberIds.forEach((id) => reset.add(id));
      pins.delete(key);
    }
    for (const id of reset) next.delete(id);
    this.commitOverrides(next, pins);
  }
  exportScenario() {
    return serializeScenario(this.committedOverrides(), this.committedBuildingPins());
  }
  importScenario(text: string, options: { history?: boolean; include?: ScenarioPartition } = {}) {
    if (text.length > MAX_SCENARIO_LENGTH) throw new Error("Scenario exceeds 2 MB.");
    const value = JSON.parse(text);
    if (
      value?.version !== 1 ||
      !Array.isArray(value.overrides) ||
      value.overrides.length > 10000
    )
      throw new Error("Unsupported scenario document.");
    let next: Overrides = new Map();
    for (const row of value.overrides) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[0] !== "string" ||
        !/^[\w%:.-]{1,160}$/.test(row[0]) ||
        next.has(row[0])
      )
        throw new Error("Invalid scenario entry.");
      const f = row[1] === null ? null : validateFeature(row[1]);
      if (f && f.id !== row[0]) throw new Error("Scenario ID mismatch.");
      next.set(row[0], f);
    }
    let pins: Pins = new Map();
    if (value.buildingPins !== undefined) {
      if (!Array.isArray(value.buildingPins) || value.buildingPins.length > 10000)
        throw new Error("Invalid building snapshot pins.");
      for (const pin of value.buildingPins as BuildingSnapshotPin[]) {
        if (!pin || typeof pin.source !== "string" || !/^[\w.-]{1,60}$/.test(pin.source) ||
            typeof pin.groupId !== "string" || !pin.groupId.length || pin.groupId.length > 500 ||
            !Array.isArray(pin.memberIds) || !pin.memberIds.length || pin.memberIds.length > 10000 ||
            new Set(pin.memberIds).size !== pin.memberIds.length ||
            pin.memberIds.some((id) => typeof id !== "string" || !next.has(id) ||
              (next.get(id) && next.get(id)!.source !== pin.source)) || pins.has(pinKey(pin)))
          throw new Error("Invalid building snapshot membership.");
        pins.set(pinKey(pin), Object.freeze({ source: pin.source, groupId: pin.groupId,
          memberIds: Object.freeze([...pin.memberIds].sort()) }));
      }
    }
    // Older v1 saves identify complete buildings through their surviving parts.
    // A deletion with only an ID still applies to that feature alone.
    const groups = new Map<string, GeoFeature[]>();
    for (const f of next.values()) {
      const key = f && buildingIdentity(f);
      if (!f || !key || pins.has(key)) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    for (const [key, members] of groups) {
      if (!buildingSelection(members).complete) continue;
      pins.set(key, Object.freeze({ source: members[0].source,
        groupId: String(members[0].properties.buildingGroup),
        memberIds: Object.freeze(members.map((f) => f.id).sort()) }));
    }
    // Check each saved partition against its own size limit before combining the records in memory.
    const include = options.include;
    if (include) {
      if ([...next].some(([id, f]) => !include(id, f)))
        throw new Error("Saved scene contains an unexpected override partition.");
      const outside: ScenarioPartition = (id, f) => !include(id, f);
      const kept = this.committedOverrides().filter(([id, f]) => outside(id, f));
      if (kept.some(([id]) => next.has(id))) throw new Error("Conflicting override partitions.");
      const keptPins = this.partitionBuildingPins(outside);
      if (keptPins.some(pin => pins.has(pinKey(pin)))) throw new Error("Conflicting building partitions.");
      next = new Map([...kept, ...next]);
      pins = new Map([...keptPins.map(pin => [pinKey(pin), pin] as const), ...pins]);
    }
    this.commitOverrides(next, pins, options.history !== false);
  }
}
