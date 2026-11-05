/**
 * @file src/rendering/AssetLayer.ts
 * @brief Draw GLB models alongside map geometry.
 * @author Norman
 * @description Loads each model on demand, reuses it across objects and limits how many appear at once. Each object can move and be picked separately.
 */
import {
  Matrix,
  Quaternion,
  Vector2,
  Vector3,
} from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import type {
  AssetContainer,
  InstantiatedEntries,
} from "@babylonjs/core/assetContainer.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { GeoFeature, LayerName } from "../geo/types.js";
import { usesModelAsset } from "../geo/types.js";
import type { ViewportSnapshot } from "../geo/Viewport.js";
import type { SceneStore } from "../geo/SceneStore.js";
import { featureExtent, intersects, localFrame, RAD } from "../geo/math.js";
import { inspectGLBResources, MAX_DECODED_GLB_BYTES, MAX_GLB_BYTES } from "../assets/validation.js";
import { surfaceFragment } from "./models/materials.js";
export type AssetResolver = (id: string) => Promise<Uint8Array>;

const vertex = (uvAttribute?: string) => `precision highp float;
attribute vec3 position; attribute vec3 normal;
${uvAttribute ? `attribute vec2 ${uvAttribute};` : ""}
uniform mat4 mapMatrix; uniform mat4 normalMatrix; uniform mat4 textureMatrix;
varying vec3 n; varying vec2 texUV;
void main(){gl_Position=mapMatrix*vec4(position,1.);n=mat3(normalMatrix)*normal;texUV=(textureMatrix*vec4(${uvAttribute ?? "vec2(0.)"},1.,0.)).xy;}`;

/** Babylon records the glTF texture's chosen TEXCOORD set on coordinatesIndex. */
function textureUV(source: PBRMaterial | null, mesh: AbstractMesh): string | undefined {
  const texture = source?.albedoTexture;
  // Untextured facade grids still use the model's first UV set.
  if (!texture) return mesh.isVerticesDataPresent("uv") ? "uv" : undefined;
  const index = texture.coordinatesIndex;
  if (!Number.isInteger(index) || index < 0 || index > 5)
    throw new Error("Use a base-colour texture UV set from TEXCOORD_0 to TEXCOORD_5.");
  const attribute = index === 0 ? "uv" : `uv${index + 1}`;
  if (!mesh.isVerticesDataPresent(attribute))
    throw new Error(`Model base-colour texture requires missing TEXCOORD_${index} data.`);
  return attribute;
}
const assetSurface = `
uniform vec3 baseColor; uniform vec3 tint; uniform float selected; uniform float opacity;
uniform float textured; uniform float cutoff; uniform sampler2D baseTexture;
uniform vec2 facadeCell;
varying vec3 n; varying vec2 texUV;
void main(){vec4 tex=vec4(1.);if(textured>.5)tex=texture2D(baseTexture,texUV);
float a=tex.a*opacity;if(a<cutoff)discard;
// Some glTF faces have no normals. Give them ambient light.
float norm2=dot(n,n);
float diffuse=norm2>0.0?abs(dot(n*inversesqrt(norm2),normalize(vec3(.3,.5,.8)))):0.0;
float light=.55+.45*diffuse;
// glTF uses linear colour factors. The textures and map framebuffer use sRGB.
vec3 linear=baseColor*pow(tex.rgb,vec3(2.2))*light;
vec3 c=pow(max(linear,vec3(0.)),vec3(1./2.2))*tint;
if(facadeCell.x>0.) {
  vec2 cell=texUV/facadeCell, aa=max(pixelWidth(cell),vec2(.002));
  vec2 edge=min(fract(cell),1.-fract(cell));
  vec2 lines=1.-smoothstep(vec2(.018)-aa,vec2(.018)+aa,edge);
  float fade=1.-smoothstep(.2,.6,max(aa.x,aa.y));
  c=mix(c,vec3(.82,.85,.83)*light,max(lines.x,lines.y)*fade*.8);
}
c=mix(c,vec3(.15,.8,.85),selected*.3);gl_FragColor=vec4(c,a);}`;
type Prototype = {
  container: AssetContainer;
  min: Vector3;
  max: Vector3;
  bytes: number;
  triangles: number;
  sections: number;
};
type Instance = {
  assetId: string;
  root: TransformNode;
  entries: InstantiatedEntries;
  meshes: AbstractMesh[];
  materials: (ShaderMaterial | MultiMaterial)[];
  surfaces: { mesh: AbstractMesh; material: ShaderMaterial; matrix: Matrix }[];
  feature?: GeoFeature;
};

export class AssetLayer {
  private features = new Map<string, GeoFeature>();
  private prototypes = new Map<string, Prototype>();
  private needed = new Set<string>();
  private prototypeLimit = 24;
  private instances = new Map<string, Instance>();
  private loading = new Set<string>();
  private failed = new Set<string>();
  private flatChargers = new WeakSet<GeoFeature>();
  private matrix = Matrix.Identity();
  private readonly fragment: string;
  private disposed = false;
  private inView = 0;
  private readyReplacements = new Set<string>();
  private deferredCreation?: string;
  get stats() {
    return {
      visible: this.instances.size,
      deferred: Math.max(0, this.inView - this.instances.size),
      triangles: [...this.instances.values()].reduce(
        (n, i) => n + (this.prototypes.get(i.assetId)?.triangles ?? 0),
        0,
      ),
      bytes: [...this.prototypes.values()].reduce((n, p) => n + p.bytes, 0),
    };
  }
  constructor(
    private scene: Scene,
    private invalidate: () => void,
    private error: (message: string) => void,
    private onReady: (assetId: string, ready: boolean) => void = () => {},
    private resolveAsset: AssetResolver = async () => { throw new Error("The host must supply resolveAsset to load GLBs."); },
  ) {
    this.fragment = surfaceFragment(assetSurface, scene.getEngine());
  }
  sync(store: SceneStore, ids: readonly string[]) {
    for (const id of ids) {
      const f = store.get(id);
      if (!f && this.features.has(id)) this.failed.clear();
      if (f && usesModelAsset(f)) {
        this.features.set(id, f);
        this.failed.delete(f.model!.assetId!);
      } else this.features.delete(id);
      if (!f || this.instances.get(id)?.assetId !== f.model?.assetId)
        this.remove(id);
    }
  }
  private remove(id: string) {
    const entry = this.instances.get(id);
    if (!entry) return;
    entry.entries.dispose();
    entry.root.dispose();
    for (const material of entry.materials) material.dispose(false, false);
    this.instances.delete(id);
  }
  /** Keep recently used GLBs in the cache after their instances leave the screen.
   * Drop older models when we need room. */
  private trimPrototypes(reserveBytes = 0, reserveCount = 0) {
    let bytes = [...this.prototypes.values()].reduce((sum, p) => sum + p.bytes, 0);
    for (const [id, prototype] of this.prototypes) {
      if (bytes + reserveBytes <= MAX_DECODED_GLB_BYTES &&
          this.prototypes.size + reserveCount <= this.prototypeLimit) break;
      if (this.needed.has(id)) continue;
      prototype.container.dispose();
      bytes -= prototype.bytes;
      this.prototypes.delete(id);
      this.failed.clear();
    }
  }
  /** Only a replacement at the original building can hide it. Copies elsewhere leave it visible. */
  private publishReplacements() {
    const next = new Set<string>();
    for (const [id, entry] of this.instances) {
      if (
        this.features.get(id)?.model?.replacement === id
      )
        next.add(entry.assetId);
    }
    const previous = this.readyReplacements;
    this.readyReplacements = next;
    for (const id of previous) if (!next.has(id)) this.onReady(id, false);
    for (const id of next) if (!previous.has(id)) this.onReady(id, true);
  }
  private reservePrototype(bytes: number) {
    this.trimPrototypes(bytes, 1);
    for (const prototype of this.prototypes.values()) bytes += prototype.bytes;
    if (bytes > MAX_DECODED_GLB_BYTES)
      throw new Error("Visible models exceed the 64 MB decoded asset budget. Remove a model or simplify its geometry/textures.");
  }
  private async load(id: string) {
    this.loading.add(id);
    let container: AssetContainer | undefined;
    try {
      const resolved = await this.resolveAsset(id);
      if (this.disposed) return;
      if (resolved.byteLength > MAX_GLB_BYTES) throw new Error("Choose a GLB between 20 bytes and 20 MB.");
      // Copy the bytes so the loader reads exactly what we validate.
      const bytes = Uint8Array.from(resolved);
      const { decodedBytes } = inspectGLBResources(bytes.buffer);
      this.reservePrototype(decodedBytes);
      await import("@babylonjs/loaders/glTF/index.js");
      const { LoadAssetContainerAsync } = await import(
        "@babylonjs/core/Loading/sceneLoader.js"
      );
      if (this.disposed) return;
      container = await LoadAssetContainerAsync(bytes, this.scene, {
        pluginExtension: ".glb",
        // Each node needs its own shader material for its projected world matrix.
        // Babylon's InstancedMesh shares one material with its source.
        pluginOptions: { gltf: {
          createInstances: false, loadNodeAnimations: false,
          preprocessUrlAsync: async () => { throw new Error("External GLB resource requests are disabled."); },
        } },
      });
      if (this.disposed) {
        container.dispose();
        return;
      }
      const min = new Vector3(Infinity, Infinity, Infinity),
        max = min.negate();
      let triangles = 0,
        pixels = 0;
      for (const mesh of container.meshes) {
        mesh.computeWorldMatrix(true);
        if (!mesh.getTotalVertices()) continue;
        const materials = mesh.material instanceof MultiMaterial
          ? mesh.material.subMaterials : [mesh.material];
        for (const material of materials) textureUV(material as PBRMaterial | null, mesh);
        const box = mesh.getBoundingInfo().boundingBox;
        min.minimizeInPlace(box.minimumWorld);
        max.maximizeInPlace(box.maximumWorld);
        triangles += (mesh.getTotalIndices() || mesh.getTotalVertices()) / 3;
      }
      for (const texture of container.textures) {
        const size = texture.getSize();
        pixels += size.width * size.height;
        if (size.width > 4096 || size.height > 4096)
          throw new Error(
            "Texture exceeds 4096 pixels. Resize textures before importing.",
          );
      }
      const span = max.subtract(min);
      if (
        ![span.x, span.y, span.z].every(Number.isFinite) ||
        Math.max(span.x, span.z) < 1e-6 ||
        triangles > 200000 ||
        pixels > 4194304
      )
        throw new Error(
          "Model exceeds scene geometry/texture limits or has invalid dimensions.",
        );
      const memory = Math.max(decodedBytes, bytes.byteLength + pixels * 4 + triangles * 3 * 32);
      this.reservePrototype(memory);
      this.prototypes.set(id, {
        container,
        min,
        max,
        bytes: memory,
        triangles,
        sections: container.meshes.reduce(
          (n, m) => n + (m.subMeshes?.length ?? 0),
          0,
        ),
      });
      this.error("");
    } catch (error) {
      container?.dispose();
      this.failed.add(id);
      if (!this.disposed) this.onReady(id, false);
      if (!this.disposed)
        this.error(
          error instanceof Error ? error.message : "Model could not load.",
        );
    } finally {
      this.loading.delete(id);
      if (!this.disposed) this.invalidate();
    }
  }
  private create(f: GeoFeature, prototype: Prototype): Instance {
    const entries = prototype.container.instantiateModelsToScene(
      (name) => `${f.id}:${name}`,
      false,
      { doNotInstantiate: true },
    );
    for (const group of entries.animationGroups) group.stop();
    const root = new TransformNode(f.id, this.scene);
    const span = prototype.max.subtract(prototype.min);
    const normalise = new TransformNode(`${f.id}:normalise`, this.scene);
    const unit = 1 / Math.max(span.x, span.z);
    normalise.scaling.setAll(unit);
    normalise.position.set(
      (-(prototype.min.x + prototype.max.x) * unit) / 2,
      -prototype.min.y * unit,
      (-(prototype.min.z + prototype.max.z) * unit) / 2,
    );
    normalise.parent = root;
    for (const node of entries.rootNodes) node.parent = normalise;
    const materials: (ShaderMaterial | MultiMaterial)[] = [];
    const surfaces: Instance["surfaces"] = [];
    const meshes = root.getChildMeshes();
    const shader = (source: PBRMaterial | null, mesh: AbstractMesh) => {
      const uvAttribute = textureUV(source, mesh);
      const material = new ShaderMaterial(
        `${f.id}:surface`,
        this.scene,
        { vertexSource: vertex(uvAttribute), fragmentSource: this.fragment },
        {
          attributes: ["position", "normal", ...(uvAttribute ? [uvAttribute] : [])],
          uniforms: [
            "mapMatrix",
            "normalMatrix",
            "textureMatrix",
            "baseColor",
            "tint",
            "selected",
            "opacity",
            "textured",
            "cutoff",
            "facadeCell",
          ],
          samplers: ["baseTexture"],
          needAlphaBlending: source?.needAlphaBlending() ?? false,
        },
      );
      material.backFaceCulling = false;
      // The optional glTF facade hint gives column and floor spacing for UVs in metres.
      // Use the grid only when both values are valid.
      const facade = source?.metadata?.gltf?.extras?.upsightduckFacade;
      const cell =
        Array.isArray(facade) &&
        facade.length === 2 &&
        facade.every(
          (v) =>
            typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 20,
        )
          ? facade
          : [0, 0];
      material.setVector2("facadeCell", new Vector2(cell[0], cell[1]));
      material.setColor3("baseColor", source?.albedoColor ?? Color3.White());
      material.setFloat("opacity", source?.alpha ?? 1);
      material.setFloat(
        "cutoff",
        source?.needAlphaTesting() ? source.alphaCutOff : 0.01,
      );
      const texture = source?.albedoTexture;
      material.setFloat("textured", texture ? 1 : 0);
      material.setMatrix(
        "textureMatrix",
        texture?.getTextureMatrix() ?? Matrix.Identity(),
      );
      if (texture) material.setTexture("baseTexture", texture);
      surfaces.push({ mesh, material, matrix: Matrix.Identity() });
      materials.push(material);
      return material;
    };
    for (const mesh of meshes) {
      mesh.alwaysSelectAsActiveMesh = true;
      if (mesh.material instanceof MultiMaterial) {
        const multi = new MultiMaterial(`${f.id}:materials`, this.scene);
        multi.subMaterials = mesh.material.subMaterials.map((m) =>
          shader(m as PBRMaterial | null, mesh),
        );
        materials.push(multi);
        mesh.material = multi;
      } else mesh.material = shader(mesh.material as PBRMaterial | null, mesh);
    }
    return {
      assetId: f.model!.assetId!,
      root,
      entries,
      meshes,
      materials,
      surfaces,
    };
  }
  render(
    view: ViewportSnapshot,
    matrix: Matrix,
    hidden: ReadonlySet<LayerName>,
    selected: string | null,
    mobile: boolean,
  ) {
    const frameStarted = performance.now(), creationBudgetMs = mobile ? 3 : 6;
    this.matrix.copyFrom(matrix);
    const distance = (f: GeoFeature) => {
      const p =
        f.geometry.type === "Point" ? f.geometry.coordinates : view.center;
      return (p[0] - view.center[0]) ** 2 + (p[1] - view.center[1]) ** 2;
    };
    const candidates = [...this.features.values()].filter(
      (f) =>
        !hidden.has(f.layer) &&
        intersects(featureExtent(f), view.bounds) &&
        // At low zoom, show the mapped building unless its replacement is selected.
        (f.model?.replacement !== f.id ||
          view.zoom >= (this.instances.has(f.id) ? 15.8 : 16.2) ||
          f.id === selected),
    );
    this.inView = candidates.length;
    const instanceLimit = mobile ? 8 : 24;
    const wanted = candidates
      .sort(
        (a, b) =>
          Number(b.id === selected) - Number(a.id === selected) ||
          distance(a) - distance(b),
      )
      .slice(0, instanceLimit);
    const ids = new Set(wanted.map((f) => f.id));
    if (this.deferredCreation && !ids.has(this.deferredCreation)) this.deferredCreation = undefined;
    for (const id of this.instances.keys()) if (!ids.has(id)) this.remove(id);
    this.needed = new Set(wanted.map((f) => f.model!.assetId!));
    this.prototypeLimit = instanceLimit;
    // Move needed models to the end so we can drop the least recently used ones first.
    // A cached model only replaces a building once it has an instance in the scene.
    for (const id of this.needed) {
      const prototype = this.prototypes.get(id);
      if (prototype) {
        this.prototypes.delete(id);
        this.prototypes.set(id, prototype);
      }
    }
    this.trimPrototypes();
    let triangles = 0,
      sections = 0,
      created = 0,
      creationBlocked = false;
    for (const f of wanted) {
      if (f.geometry.type !== "Point") continue;
      const assetId = f.model!.assetId!,
        prototype = this.prototypes.get(assetId);
      if (!prototype) {
        this.trimPrototypes(0, 1);
        if (
          !this.loading.has(assetId) &&
          !this.failed.has(assetId) &&
          this.loading.size < 1 &&
          this.prototypes.size < instanceLimit &&
          [...this.prototypes.values()].reduce((n, p) => n + p.bytes, 0) <
            MAX_DECODED_GLB_BYTES
        )
          void this.load(assetId);
        continue;
      }
      if (f.model!.kind === "charger" && prototype.max.y - prototype.min.y < 1e-6) {
        this.remove(f.id);
        if (!this.flatChargers.has(f)) {
          this.flatChargers.add(f);
          this.error(`Charger ${f.id} needs a model with nonzero height.`);
        }
        continue;
      }
      if (
        triangles + prototype.triangles > (mobile ? 300000 : 1000000) ||
        sections + prototype.sections > (mobile ? 128 : 256)
      ) {
        this.remove(f.id);
        continue;
      }
      triangles += prototype.triangles;
      sections += prototype.sections;
      let instance = this.instances.get(f.id);
      if (!instance) {
        if (created >= 1 || creationBlocked) {
          this.invalidate();
          continue;
        }
        // Babylon clones a whole model in one step. Start at most one per frame.
        // If earlier work took too long, give this model another frame to start.
        if (performance.now() - frameStarted >= creationBudgetMs && this.deferredCreation !== f.id) {
          this.deferredCreation = f.id;
          creationBlocked = true;
          this.invalidate();
          continue;
        }
        this.deferredCreation = undefined;
        instance = this.create(f, prototype);
        this.instances.set(f.id, instance);
        created++;
      }
      if (instance.feature === f) continue;
      const frame = localFrame(f.geometry.coordinates);
      const span = prototype.max.subtract(prototype.min);
      // Scale chargers by height and other models by their longest horizontal side.
      const length =
        f.model!.kind === "charger"
          ? (f.style.height * Math.max(span.x, span.z)) / span.y
          : f.model!.length!;
      const transform = Matrix.Scaling(length, length, length)
        .multiply(Matrix.RotationY(-(f.model!.heading ?? 0) * RAD))
        .multiply(Matrix.Translation(0, f.style.elevation, 0))
        .multiply(
          Matrix.Compose(
            new Vector3(frame.scale, frame.scale, frame.scale),
            Quaternion.FromEulerAngles(Math.PI / 2, 0, 0),
            new Vector3(frame.anchor[0], frame.anchor[1], 0),
          ),
        );
      instance.root.freezeWorldMatrix(transform);
      for (const mesh of instance.meshes) mesh.computeWorldMatrix(true);
      instance.feature = f;
    }
    // Show the mapped building again when its replacement leaves the scene.
    // The host handles explicit moves and deletions.
    this.publishReplacements();
    // Set these values before scene.render because ShaderMaterial uploads them before onBind.
    for (const [id, instance] of this.instances) {
      const tint = Color3.FromHexString(
        this.features.get(id)?.style.color ?? "#ffffff",
      );
      for (const surface of instance.surfaces) {
        const world = surface.mesh.getWorldMatrix();
        world.multiplyToRef(this.matrix, surface.matrix);
        surface.material.setMatrix("mapMatrix", surface.matrix);
        surface.material.setMatrix("normalMatrix", world);
        surface.material.setFloat("selected", selected === id ? 1 : 0);
        surface.material.setColor3("tint", tint);
      }
    }
  }
  pick(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { id: string; distance: number } | null {
    if (!this.instances.size || !(width > 0 && height > 0)) return null;
    // Use the shader's local-to-clip matrix to turn the screen point into a picking ray.
    // If the host created an engine first, Babylon may use 32-bit temporary matrices.
    // At Mercator scale that rounding can move the pick by several metres.
    const engine = this.scene.getEngine();
    const nearZ = engine.isNDCHalfZRange ? 0 : -1;
    const near = new Vector3(x / width * 2 - 1, 1 - y / height * 2, engine.useReverseDepthBuffer ? 1 : nearZ);
    const far = new Vector3(near.x, near.y, engine.useReverseDepthBuffer ? nearZ + 1e-8 : 1 - 1e-8);
    const inverse = Matrix.Identity(), ray = Ray.Zero();
    let closest: { id: string; distance: number } | null = null;
    for (const [id, entry] of this.instances)
      for (const mesh of entry.meshes) {
        if (!mesh.getTotalVertices()) continue;
        mesh.getWorldMatrix().multiplyToRef(this.matrix, inverse);
        inverse.invert();
        Vector3.TransformCoordinatesToRef(near, inverse, ray.origin);
        Vector3.TransformCoordinatesToRef(far, inverse, ray.direction);
        ray.direction.subtractInPlace(ray.origin).normalize();
        const hit = mesh.intersects(ray, false);
        if (hit.hit && (!closest || hit.distance < closest.distance))
          closest = { id, distance: hit.distance };
      }
    return closest;
  }
  dispose() {
    this.disposed = true;
    this.deferredCreation = undefined;
    for (const id of this.instances.keys()) this.remove(id);
    this.publishReplacements();
    for (const p of this.prototypes.values()) p.container.dispose();
    this.prototypes.clear();
    this.needed.clear();
    this.features.clear();
  }
}
