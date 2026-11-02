/** @file Check static GLB models before loading them. @author Norman */
export const MAX_GLB_BYTES = 20 * 1024 * 1024;
export const MAX_DECODED_GLB_BYTES = 64 * 1024 * 1024;
const maxPixels = 4_194_304;
const maxTriangles = 200_000;

// Allow only extensions that use data inside the file. Other extensions can require extra
// decoders, fetch files, or create more scene objects than the renderer can handle.
const staticExtensions = new Set([
  "KHR_mesh_quantization", "KHR_texture_transform", "KHR_materials_unlit",
  "KHR_materials_clearcoat", "KHR_materials_emissive_strength", "KHR_materials_ior",
  "KHR_materials_iridescence", "KHR_materials_sheen", "KHR_materials_specular",
  "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_anisotropy",
  "KHR_materials_pbrSpecularGlossiness", "KHR_materials_dispersion",
]);

type BufferRange = { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number };
type AccessorRange = { bufferView: number; byteOffset?: number };
type Accessor = { count: number; type: string; componentType: number; bufferView?: number; byteOffset?: number;
  sparse?: { count: number; indices: AccessorRange & { componentType: number }; values: AccessorRange } };
type Primitive = { attributes?: Record<string, number>; indices?: number; mode?: number; targets?: unknown[] };
type Metadata = {
  asset?: { version?: string };
  meshes?: { primitives: Primitive[] }[];
  nodes?: { mesh?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: BufferRange[];
  accessors?: Accessor[];
  images?: { uri?: string; bufferView: number; mimeType: string }[];
  textures?: { source: number }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  skins?: unknown[];
};

function imageDimensions(bytes: DataView, mime: string): [number, number] {
  if (mime === "image/png" && bytes.byteLength >= 33 &&
      bytes.getUint32(0) === 0x89504e47 && bytes.getUint32(4) === 0x0d0a1a0a &&
      bytes.getUint32(8) === 13 && bytes.getUint32(12) === 0x49484452)
    return [bytes.getUint32(16), bytes.getUint32(20)];
  if (mime === "image/jpeg" && bytes.byteLength >= 4 && bytes.getUint16(0) === 0xffd8) {
    let i = 2;
    while (i + 3 < bytes.byteLength && bytes.getUint8(i++) === 0xff) {
      // JPEG markers can start with more than one 0xFF byte.
      while (i < bytes.byteLength && bytes.getUint8(i) === 0xff) i++;
      if (i + 2 >= bytes.byteLength) break;
      const marker = bytes.getUint8(i++), size = bytes.getUint16(i);
      if (size < 2 || i + size > bytes.byteLength || marker === 0xda || marker === 0xd9) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 8)
        return [bytes.getUint16(i + 5), bytes.getUint16(i + 3)];
      i += size;
    }
  }
  throw new Error("Use embedded PNG or JPEG textures with valid dimensions.");
}

/** Estimate memory use from mesh data and image headers before Babylon loads the model. */
export function inspectGLBResources(bytes: ArrayBuffer) {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_GLB_BYTES)
    throw new Error("Choose a GLB between 20 bytes and 20 MB.");
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength)
    throw new Error("Invalid GLB 2.0 header.");
  const size = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || size % 4 !== 0 ||
      size > bytes.byteLength - 20 || size > 4 * 1024 * 1024)
    throw new Error("Invalid GLB metadata.");
  const doc: Metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, size)));
  if (doc.asset?.version !== "2.0" || !Array.isArray(doc.meshes) || !doc.meshes.length ||
      doc.meshes.length > 128 || (doc.nodes?.length ?? 0) > 512)
    throw new Error("GLB needs 1–128 meshes and at most 512 nodes.");
  if ([...(doc.buffers ?? []), ...(doc.images ?? [])].some((v) => v.uri !== undefined))
    throw new Error("Use a self-contained GLB with embedded buffers and textures.");
  const declared = new Set(doc.extensionsUsed ?? []);
  for (const name of [...declared, ...(doc.extensionsRequired ?? [])]) {
    if (/draco|meshopt|basisu|webp|avif/i.test(name))
      throw new Error("Export an uncompressed GLB; compressed mesh/texture decoders are not enabled yet.");
    if (!staticExtensions.has(name))
      throw new Error(`Extension ${name} is not supported in self-contained static GLBs.`);
    if (!declared.has(name)) throw new Error(`Required GLB extension ${name} is undeclared.`);
  }
  // Nodes and materials can use extensions missing from extensionsUsed. Skip extras,
  // which holds application data rather than instructions for the model loader.
  const objects: object[] = [doc];
  while (objects.length) {
    for (const [key, value] of Object.entries(objects.pop()!)) {
      if (key === "extras" || typeof value !== "object" || !value) continue;
      if (key === "extensions") {
        for (const name of Object.keys(value))
          if (!declared.has(name)) throw new Error(`Undeclared GLB extension ${name}.`);
      }
      objects.push(value);
    }
  }

  let binOffset = 0, binSize = 0;
  for (let offset = 20 + size; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error("Invalid GLB chunk.");
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (length % 4 || length > bytes.byteLength - offset - 8) throw new Error("Invalid GLB chunk.");
    if (type === 0x004e4942) {
      if (binOffset || offset !== 20 + size) throw new Error("Invalid GLB binary chunk.");
      binOffset = offset + 8; binSize = length;
    }
    offset += length + 8;
  }
  const bufferSize = doc.buffers?.[0]?.byteLength ?? 0;
  if ((doc.buffers?.length ?? 0) > 1 || !Number.isSafeInteger(bufferSize) || bufferSize < 0 || bufferSize > binSize)
    throw new Error("Invalid embedded GLB buffer.");
  for (const range of doc.bufferViews ?? []) {
    const start = range.byteOffset ?? 0;
    if (range.buffer !== 0 || !Number.isSafeInteger(start) || start < 0 ||
        !Number.isSafeInteger(range.byteLength) || range.byteLength < 1 ||
        start + range.byteLength > bufferSize || (range.byteStride !== undefined &&
        (!Number.isInteger(range.byteStride) || range.byteStride < 4 || range.byteStride > 252 || range.byteStride % 4)))
      throw new Error("Invalid embedded GLB buffer view.");
  }

  // A small file can expand into a large array when missing values are filled with zeros.
  const components = new Map([["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4],
    ["MAT2", 4], ["MAT3", 9], ["MAT4", 16]]);
  const componentBytes = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
  const checkRange = (ref: AccessorRange, count: number, elementSize: number, lastSize = elementSize) => {
    const range = doc.bufferViews?.[ref.bufferView], offset = ref.byteOffset ?? 0;
    if (!range || !Number.isSafeInteger(offset) || offset < 0 ||
        offset + (count - 1) * (range.byteStride ?? elementSize) + lastSize > range.byteLength)
      throw new Error("GLB accessor exceeds its embedded buffer view.");
  };
  let decodedBytes = bytes.byteLength;
  for (const a of doc.accessors ?? []) {
    const width = components.get(a.type), unit = componentBytes.get(a.componentType);
    if (!width || !unit || !Number.isSafeInteger(a.count) || a.count < 1)
      throw new Error("Invalid GLB accessor.");
    decodedBytes += a.count * width * 4;
    if (decodedBytes > MAX_DECODED_GLB_BYTES)
      throw new Error("GLB accessors exceed the 64 MB decoded asset budget.");
    // Each glTF matrix column starts on a four-byte boundary.
    const cols = a.type.startsWith("MAT") ? Math.sqrt(width) : 1;
    const elementSize = cols === 1 ? width * unit : cols * Math.ceil(cols * unit / 4) * 4;
    const lastSize = cols === 1 ? elementSize : elementSize - (elementSize / cols - cols * unit);
    if (a.bufferView !== undefined) checkRange({ bufferView: a.bufferView, byteOffset: a.byteOffset }, a.count, elementSize, lastSize);
    if (a.sparse) {
      const sparse = a.sparse, indexSize = componentBytes.get(sparse.indices.componentType);
      if (!Number.isSafeInteger(sparse.count) || sparse.count < 1 || sparse.count > a.count ||
          !indexSize || ![5121, 5123, 5125].includes(sparse.indices.componentType))
        throw new Error("Invalid sparse GLB accessor.");
      checkRange(sparse.indices, sparse.count, indexSize);
      checkRange(sparse.values, sparse.count, elementSize, lastSize);
      if (a.componentType !== 5126) decodedBytes += sparse.count * width * 4;
    }
  }

  const vertexViews = new Set<number>(), expandedAttributes = new Set<string>();
  const meshes = doc.meshes.map((m) => {
    if (!Array.isArray(m.primitives) || !m.primitives.length || m.primitives.length > 128)
      throw new Error("Use triangle meshes with 1–128 material sections.");
    let triangles = 0;
    for (const p of m.primitives) {
      if (p.targets?.length || doc.skins?.length)
        throw new Error("Use a static model without skinning or morph targets.");
      if (p.mode !== undefined && p.mode !== 4)
        throw new Error("Use triangle meshes with at most 128 material sections.");
      const position = doc.accessors?.[p.attributes?.POSITION ?? -1];
      const indices = p.indices === undefined ? undefined : doc.accessors?.[p.indices];
      if (!position || position.type !== "VEC3" ||
          (p.indices !== undefined && (!indices || indices.type !== "SCALAR" ||
          ![5121, 5123, 5125].includes(indices.componentType))))
        throw new Error("Missing mesh geometry.");
      for (const [semantic, index] of Object.entries(p.attributes ?? {})) {
        const a = doc.accessors?.[index];
        if (!Number.isInteger(index) || !a) throw new Error("Invalid vertex attribute accessor.");
        if (a.bufferView !== undefined && !a.sparse) {
          // Babylon uploads each distinct buffer view in full. Count overlapping views
          // separately, even if the mesh uses only a few vertices from each.
          if (!vertexViews.has(a.bufferView)) {
            vertexViews.add(a.bufferView);
            decodedBytes += doc.bufferViews![a.bufferView].byteLength;
          }
        } else {
          const key = `${index}:${semantic}`;
          if (!expandedAttributes.has(key)) {
            expandedAttributes.add(key);
            decodedBytes += a.count * components.get(a.type)! * 4;
          }
        }
      }
      const count = (indices ?? position).count;
      if (count < 3 || count % 3) throw new Error("Invalid GLB triangle count.");
      triangles += count / 3;
    }
    return triangles;
  });
  if (doc.meshes.reduce((n, m) => n + m.primitives.length, 0) > 128)
    throw new Error("Use triangle meshes with at most 128 material sections.");
  const triangles = meshes.reduce((n, count) => n + count, 0);
  let placedTriangles = 0;
  for (const node of doc.nodes ?? []) {
    if (node.mesh === undefined) continue;
    if (!Number.isInteger(node.mesh) || meshes[node.mesh] === undefined) throw new Error("Invalid GLB mesh reference.");
    placedTriangles += meshes[node.mesh];
  }
  if (Math.max(triangles, placedTriangles) > maxTriangles)
    throw new Error("Model exceeds 200,000 triangles. Simplify it before importing.");

  if ((doc.images?.length ?? 0) > 16 || (doc.textures?.length ?? 0) > 16)
    throw new Error("Use at most 16 embedded textures.");
  const imagePixels = (doc.images ?? []).map((image) => {
    const range = doc.bufferViews?.[image.bufferView];
    if (!range) throw new Error("Use embedded PNG or JPEG textures.");
    const dimensions = imageDimensions(new DataView(bytes, binOffset + (range.byteOffset ?? 0), range.byteLength), image.mimeType);
    if (dimensions.some((n) => n < 1 || n > 4096)) throw new Error("Texture exceeds supported dimensions (1–4096 pixels).");
    return dimensions[0] * dimensions[1];
  });
  const texturePixels = (doc.textures ?? []).reduce((total, texture) => {
    const pixels = imagePixels[texture.source];
    if (pixels === undefined) throw new Error("Invalid GLB texture reference.");
    return total + pixels;
  }, 0);
  const pixels = Math.max(texturePixels, imagePixels.reduce((sum, n) => sum + n, 0));
  if (pixels > maxPixels) throw new Error("GLB exceeds the embedded texture pixel budget.");
  decodedBytes = pixels * 4 + Math.max(decodedBytes, bytes.byteLength + placedTriangles * 3 * 32);
  if (decodedBytes > MAX_DECODED_GLB_BYTES) throw new Error("GLB exceeds the 64 MB decoded asset budget.");
  return { triangles, meshes: doc.meshes.length, decodedBytes };
}

/** Check that a GLB fits the model limits and embeds its buffers and textures. */
export function inspectGLB(bytes: ArrayBuffer) {
  const { triangles, meshes } = inspectGLBResources(bytes);
  return { triangles, meshes };
}
