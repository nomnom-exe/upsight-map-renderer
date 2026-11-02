/**
 * @file geo/persistence.ts
 * @brief Save committed scene edits separately from provider data.
 * @author Norman
 */
import { SceneStore, serializeScenario, type ScenarioPartition } from "./SceneStore.js";

export interface SceneStorage { load(): string | null; save(value: string): void }
export interface PersistenceOptions {
  /** Choose which edits to store together, such as edits to chargers. */
  include?: ScenarioPartition;
  onError?: (error: Error) => void;
}
export function localSceneStorage(storage: Pick<Storage, "getItem" | "setItem">, key: string): SceneStorage {
  return { load: () => storage.getItem(key), save: (value) => storage.setItem(key, value) };
}
/** Save edits synchronously when they are committed. Source updates and drag previews skip storage.
 * If the saved scene cannot be loaded, this connection leaves the existing save untouched. */
export function connectScenePersistence(store: SceneStore, storage: SceneStorage, options: PersistenceOptions = {}) {
  const include = options.include ?? (() => true);
  let writable = true;
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  try {
    const text = storage.load();
    if (text !== null) store.importScenario(text, { history: false, include });
  } catch (error) { writable = false; report(error); }
  let previousError: string | undefined;
  const encode = () => {
    try {
      const next = serializeScenario(store.committedOverrides().filter(([id, f]) => include(id, f)),
        store.partitionBuildingPins(include));
      previousError = undefined;
      return next;
    } catch (error) {
      // Retry after an edit fixes the size limit or reunites a building's parts.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== previousError) report(error);
      previousError = message;
      return undefined;
    }
  };
  let previous = encode();
  return store.subscribe(({ reason }) => {
    if (reason !== "commit" || !writable) return;
    try {
      const next = encode();
      if (next === undefined || next === previous) return;
      storage.save(next); previous = next;
    } catch (error) { report(error); }
  });
}
