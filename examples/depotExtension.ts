/** @file examples/depotExtension.ts @brief Render a depot at a point on the map. @author Norman */
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { localFrame, RAD, type GeoFeature, type RendererExtensionFactory } from "@upsight/map-renderer";

/** Register this extension in RendererOptions.extensions. The host app supplies each
 * depot as a Point feature with model.kind set to "custom" and model.rendererId set to "depot". */
export const depotExtension: RendererExtensionFactory = {
  id: "depot",
  create({ scene }) {
    const objects = new Map<string, { feature: GeoFeature; mesh: Mesh; material: ShaderMaterial; world: Matrix; combined: Matrix; scale: number }>();
    const remove = (id: string) => { const o = objects.get(id); o?.mesh.dispose(); o?.material.dispose(); objects.delete(id); };
    return {
      sync(changes) {
        for (const [id, feature] of changes) {
          remove(id);
          if (!feature) continue;
          if (feature.geometry.type !== "Point") throw new Error("The depot recipe accepts Point geometry.");
          const { anchor, scale } = localFrame(feature.geometry.coordinates);
          const mesh = MeshBuilder.CreateBox(id, { width: feature.style.width, depth: feature.style.width, height: feature.style.height }, scene);
          mesh.bakeTransformIntoVertices(Matrix.Translation(0, feature.style.elevation + feature.style.height / 2, 0));
          mesh.alwaysSelectAsActiveMesh = true;
          const material = new ShaderMaterial(`${id}-depot`, scene, {
            vertexSource: "precision highp float; attribute vec3 position; uniform mat4 mapMatrix; void main(){gl_Position=mapMatrix*vec4(position,1.0);}",
            fragmentSource: "precision highp float; uniform vec3 baseColor; uniform float selected; void main(){gl_FragColor=vec4(mix(baseColor,vec3(1.0,0.7,0.1),selected),1.0);}",
          }, { attributes: ["position"], uniforms: ["mapMatrix", "baseColor", "selected"] });
          material.setColor3("baseColor", Color3.FromHexString(feature.style.color));
          mesh.material = material;
          // Rotate the depot in local metres before projecting it to Mercator, just as built-in point models do.
          const world = Matrix.RotationY(-(feature.model?.heading ?? 0) * RAD).multiply(
            Matrix.Compose(new Vector3(scale, scale, scale), Quaternion.FromEulerAngles(Math.PI / 2, 0, 0), new Vector3(anchor[0], anchor[1], 0)),
          );
          objects.set(id, { feature, mesh, material, world, combined: Matrix.Identity(), scale });
        }
      },
      render({ cameraMatrix, viewport, hidden, selected }) {
        for (const [id, o] of objects) {
          const p = o.feature.geometry.coordinates as readonly [number, number];
          const b = viewport.bounds;
          o.mesh.setEnabled(!hidden.has(o.feature.layer) && p[0] >= b.west && p[0] <= b.east && p[1] >= b.south && p[1] <= b.north);
          o.world.multiplyToRef(cameraMatrix, o.combined);
          o.material.setMatrix("mapMatrix", o.combined);
          o.material.setFloat("selected", selected === id ? 1 : 0);
        }
      },
      pick(x, y, width, height) {
        let result: { id: string; distance: number } | null = null;
        for (const [id, o] of objects) {
          if (!o.mesh.isEnabled()) continue;
          const ray = Ray.CreateNew(x, y, width, height, Matrix.Identity(), Matrix.Identity(), o.combined);
          const hit = ray.intersectsMesh(o.mesh, false), distance = hit.distance * o.scale;
          if (hit.hit && (!result || distance < result.distance)) result = { id, distance };
        }
        return result;
      },
      dispose() { for (const id of objects.keys()) remove(id); },
    };
  },
};
