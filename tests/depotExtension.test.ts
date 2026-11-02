/** @file tests/depotExtension.test.ts @brief Test that the example depot can still be picked after an edit using Babylon's CPU engine. @author Norman */
import { expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { depotExtension } from "../examples/depotExtension";
import { MapCamera } from "@upsight/map-renderer/engine/MapCamera";
import { SceneStore, DEFAULT_STYLE, localFrame, type GeoFeature } from "@upsight/map-renderer";

it("applies heading and colour edits to the shipped recipe and keeps picking in the rendered footprint", () => {
  const center = [103.85, 1.3] as const;
  const camera = new MapCamera(center);
  camera.resize(800, 600);
  camera.setView({ zoom: 20, pitch: 0, bearing: 0 });
  const engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512,
    deterministicLockstep: false, lockstepMaxSteps: 4, useHighPrecisionMatrix: true });
  const scene = new Scene(engine), store = new SceneStore();
  const recipe = depotExtension.create({ scene, store, invalidate: vi.fn() });
  const feature: GeoFeature = {
    id: "partner:depot", source: "partner", layer: "custom:depots", label: "Depot", properties: {},
    geometry: { type: "Point", coordinates: center },
    style: { ...DEFAULT_STYLE, width: 10, height: 6, elevation: 0, color: "#336699" },
    model: { kind: "custom", rendererId: "depot", heading: 0 },
  };
  const draw = () => recipe.render({ viewport: camera.snapshot(), cameraMatrix: camera.transform,
    hidden: new Set(), selected: null });
  const pick = (east: number, north: number) => {
    const screen = camera.project(localFrame(center).unproject(east, north), 6)!;
    return recipe.pick!(screen.x, screen.y, 800, 600);
  };
  try {
    store.execute({ type: "upsert", features: [feature] });
    recipe.sync(new Map([[feature.id, store.get(feature.id)]]));
    draw();
    expect(pick(4.8, 2)?.id).toBe(feature.id);
    expect(pick(5.5, 0)).toBeNull();
    expect(scene.materials[0].serialize().colors3.baseColor).toEqual([0.2, 0.4, 0.6]);

    const before = scene.meshes[0];
    const rotated = store.transformSelection(feature.id, 0, 0, 30)[0];
    store.execute({ type: "upsert", features: [{ ...rotated, style: { ...rotated.style, color: "#CC3300" } }] });
    recipe.sync(new Map([[feature.id, store.get(feature.id)]]));
    draw();
    expect(before.isDisposed()).toBe(true);
    expect(scene.meshes).toHaveLength(1);
    expect(pick(4.8, 2)).toBeNull();
    expect(pick(5.5, 0)?.id).toBe(feature.id);
    expect(pick(0, 0)?.id).toBe(feature.id);
    expect(scene.materials[0].serialize().colors3.baseColor).toEqual([0.8, 0.2, 0]);

    recipe.render({ viewport: camera.snapshot(), cameraMatrix: camera.transform,
      hidden: new Set([feature.layer]), selected: null });
    expect(pick(0, 0)).toBeNull();
    recipe.sync(new Map([[feature.id, undefined]]));
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);
  } finally {
    recipe.dispose();
    scene.dispose();
    engine.dispose();
  }
});
