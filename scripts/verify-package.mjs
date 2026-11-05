/** @file Test archive and Git installation in temporary apps. @author Norman */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const { values: options } = parseArgs({ options: {
  browser: { type: "boolean", default: false },
  "archive-only": { type: "boolean", default: false },
  "pack-destination": { type: "string" },
} });
const require = createRequire(import.meta.url);
const sourceManifest = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
const dir = mkdtempSync(path.join(tmpdir(), "upsight-map-consumer-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run verify.");
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
npm(["run", "build"], workspace);
const [pack] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", dir], workspace));
assert.ok(pack.files.some(f => f.path === "dist/rendering/geometry.worker.js"));
assert.ok(pack.files.some(f => f.path === "dist/geo/routeSurface.worker.js"));
assert.ok(pack.files.some(f => f.path === "README.rst"));
assert.ok(pack.files.some(f => f.path === "docs/API.rst"));
assert.ok(pack.files.some(f => f.path === "docs/DATA.rst"));
assert.ok(pack.files.some(f => f.path === "examples/depotExtension.ts"));
assert.ok(pack.files.some(f => f.path === "examples/partnerModels.ts"));
assert.ok(pack.files.some(f => f.path === "examples/basicMap.ts"));
assert.ok(pack.files.some(f => f.path === "examples/standaloneMap.ts"));
assert.ok(!pack.files.some(f => /citypack|\.glb$|\.env|\.blend|\.test\./.test(f.path)), "No app data or test assets in the SDK.");
const installed = path.join(dir, "node_modules/@upsight/map-renderer");
// Install the archive without MapLibre first to check that the core works on its own.
writeFileSync(path.join(dir, "package.json"), JSON.stringify({
  private: true, type: "module", dependencies: {
    "@upsight/map-renderer": `file:${pack.filename}`,
  },
}));
console.log("Installing packed SDK into an isolated consumer (registry/cache access required)...");
const archiveInstallStart = performance.now();
npm(["install", "--no-audit", "--no-fund"], dir);
console.log(`Archive installation completed in ${((performance.now() - archiveInstallStart) / 1000).toFixed(1)} seconds.`);
assert.equal(realpathSync(installed), installed, "SDK must be an installed archive, not a workspace link.");
assert.ok(!existsSync(path.join(dir, "node_modules/maplibre-gl")), "MapLibre must remain optional.");
for (const name of ["typescript", "vitest", "esbuild"]) {
  assert.ok(!existsSync(path.join(dir, "node_modules", name)), `${name} must not be installed by archive consumers.`);
}
for (const file of ["src", "tests", "tsconfig.json"]) {
  assert.ok(!existsSync(path.join(installed, file)), `${file} must not ship in the archive.`);
}
const archiveLock = JSON.parse(readFileSync(path.join(dir, "package-lock.json"), "utf8"));
assert.equal(archiveLock.packages["node_modules/@upsight/map-renderer"].integrity, pack.integrity,
  "The installed archive must match the verified package.");
writeFileSync(path.join(dir, "consumer.mjs"), `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SceneStore, DEFAULT_STYLE, applyFeatureEnvelope, LiveEventLayer, RoadSurfaceIndex, RouteSurfaceResolver, RoutePlayback, RouteSampler, fromGeoJSON, routeFeature, groupAnnotations } from '@upsight/map-renderer';
import { RoutePlayback as PlaybackEntry } from '@upsight/map-renderer/engine/RoutePlayback';
assert.ok(import.meta.resolve('@upsight/map-renderer').startsWith(new URL('./node_modules/', import.meta.url).href));
for (const entry of ['@upsight/map-renderer/babylon', '@upsight/map-renderer/geometry.worker.js', '@upsight/map-renderer/routeSurface.worker.js', '@babylonjs/core', '@babylonjs/loaders', 'earcut']) {
  assert.ok(existsSync(new URL(import.meta.resolve(entry))), entry + ' must be installed');
}
const store = new SceneStore();
applyFeatureEnvelope(store, { schemaVersion: 1, source: { id: 'partner', label: 'Partner', status: 'snapshot', attribution: 'Fixture' }, features: [{ id: 'partner:label', source: 'partner', layer: 'annotations', label: 'Depot', geometry: { type: 'Point', coordinates: [103.8,1.3] }, model: { kind: 'label' }, style: DEFAULT_STYLE, properties: {} }] });
assert.equal(store.size, 1);
const live = new LiveEventLayer(store, {id:'traffic',label:'Traffic',attribution:'Fixture'});
live.apply({schemaVersion:1,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),events:[{id:'incident',kind:'accident',label:'Accident',message:'Fixture',geometry:{type:'Point',coordinates:[103.8,1.3]}}]});
assert.equal(store.isEditable('traffic:incident'), false);
live.dispose(); assert.equal(store.size, 1);
const route = {positions:[[103.8,1.3],[103.801,1.3]],durationSeconds:10,distanceMetres:111,source:'fixture'};
assert.equal(fromGeoJSON({type:'Feature',id:'depot',geometry:{type:'Point',coordinates:[103.8,1.3]},properties:{name:'Depot'}},'partner').features.length, 1);
assert.equal(routeFeature(route).geometry.coordinates.length, 2);
assert.equal(groupAnnotations([{id:'depot',x:20,y:30,count:1}],200,200).length, 1);
assert.equal(RoutePlayback, PlaybackEntry);
const playback = new RoutePlayback();
playback.setRoute({...route, elevations:[-4,-4], segmentMask:[false]});
playback.play(); playback.tick(5);
assert.equal(playback.state.progress, 0.5);
assert.equal(playback.state.elevation, -4);
assert.equal(playback.state.surfaceVisible, false);
assert.ok(new RouteSampler(route.positions).length > 100);
playback.clear(); assert.equal(playback.state, null);
assert.ok(new RoadSurfaceIndex([],route.positions[0]).resolve(route).surfaceMatch.unknown > 0);
const resolver = new RouteSurfaceResolver(null); let resolved = false;
resolver.resolve(route, () => { resolved = true; }); assert.ok(resolved); resolver.dispose();
const restored = new SceneStore(); store.execute({type:'remove',ids:['partner:label']}); restored.importScenario(store.exportScenario());
console.log('Installed SDK imports in Node without browser globals; scene contract passes.');
`);
console.log(execFileSync(process.execPath, ["consumer.mjs"], { cwd: dir, encoding: "utf8" }).trim());

if (!options["archive-only"]) {
  // A source-only Git checkout must build during installation, without a manual build.
  const gitDir = mkdtempSync(path.join(tmpdir(), "upsight-git-consumer-"));
  const sourceDir = path.join(gitDir, "source repo");
  mkdirSync(sourceDir);
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  for (const file of git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], workspace).split("\0").filter(Boolean)) {
    if (/^(dist|node_modules)\//.test(file) || !existsSync(path.join(workspace, file))) continue;
    const target = path.join(sourceDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(workspace, file), target);
  }
  assert.ok(!existsSync(path.join(sourceDir, "dist")), "Git fixture must not contain compiled files.");
  git(["init", "--quiet"], sourceDir);
  git(["config", "core.autocrlf", "false"], sourceDir);
  git(["add", "."], sourceDir);
  git(["-c", "user.name=Package verification", "-c", "user.email=package-test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=disabled-hooks",
    "commit", "--quiet", "-m", "Test source installation"], sourceDir);
  const revision = git(["rev-parse", "HEAD"], sourceDir).trim();
  writeFileSync(path.join(gitDir, "package.json"), JSON.stringify({
    private: true, type: "module", dependencies: {
      "@upsight/map-renderer": `git+${pathToFileURL(sourceDir).href}#${revision}`,
    },
  }));
  console.log("Installing SDK from source-only Git repository with automatic preparation...");
  npm(["install", "--no-audit", "--no-fund"], gitDir);
  const gitInstalled = path.join(gitDir, "node_modules/@upsight/map-renderer");
  assert.equal(realpathSync(gitInstalled), gitInstalled, "Git SDK must be installed, not linked.");
  for (const file of ["dist/index.js", "dist/index.d.ts", "dist/rendering/geometry.worker.js", "dist/geo/routeSurface.worker.js"]) {
    assert.ok(existsSync(path.join(gitInstalled, file)), `Git install must build ${file}.`);
  }
  for (const name of ["typescript", "vitest", "esbuild", "maplibre-gl"]) {
    assert.ok(!existsSync(path.join(gitDir, "node_modules", name)), `${name} must not be required by the consumer.`);
  }
  assert.ok(!existsSync(path.join(gitInstalled, "src")), "Only the built library should ship.");
  copyFileSync(path.join(dir, "consumer.mjs"), path.join(gitDir, "consumer.mjs"));
  console.log(execFileSync(process.execPath, ["consumer.mjs"], { cwd: gitDir, encoding: "utf8" }).trim());
  const lock = JSON.parse(readFileSync(path.join(gitDir, "package-lock.json"), "utf8"));
  assert.ok(lock.packages["node_modules/@upsight/map-renderer"].resolved.endsWith(`#${revision}`), "Lockfile must pin the Git commit.");
  for (const file of ["dist/rendering/geometry.worker.js", "dist/geo/routeSurface.worker.js"]) {
    await build({ entryPoints: [path.join(gitInstalled, file)], bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" });
  }
  console.log("Git installation, automatic dependencies and worker bundles passed.");
}

npm(["install", "--ignore-scripts", "--no-audit", "--no-fund",
  `maplibre-gl@${sourceManifest.devDependencies["maplibre-gl"]}`,
  `typescript@${JSON.parse(readFileSync(require.resolve("typescript/package.json"), "utf8")).version}`], dir);
writeFileSync(path.join(dir, "consumer.ts"), `
import { SceneStore, LabelLayer, LiveEventLayer, RouteSurfaceResolver, RoutePlayback, RouteSampler, fromGeoJSON, routeFeature, groupAnnotations, type PlaybackState, type RendererExtensionFactory } from '@upsight/map-renderer';
import { BabylonRenderer } from '@upsight/map-renderer/babylon';
import { MapLibreConnection } from '@upsight/map-renderer/maplibre';
import { depotExtension } from './node_modules/@upsight/map-renderer/examples/depotExtension.js';
import { createPartnerModels } from './node_modules/@upsight/map-renderer/examples/partnerModels.js';
import { createBasicMap } from './node_modules/@upsight/map-renderer/examples/basicMap.js';
import { createStandaloneMap } from './node_modules/@upsight/map-renderer/examples/standaloneMap.js';
export const API = { SceneStore, BabylonRenderer, MapLibreConnection, LabelLayer, LiveEventLayer, RouteSurfaceResolver, RoutePlayback, RouteSampler, fromGeoJSON, routeFeature, groupAnnotations, depotExtension, createPartnerModels, createBasicMap, createStandaloneMap };
export const playbackState: PlaybackState | null = new RoutePlayback().state;
export const plugin: RendererExtensionFactory = { id: 'custom', create: () => ({ sync() {}, render() {}, dispose() {} }) };
`);
execFileSync(process.execPath, [path.join(dir, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "consumer.ts"], { cwd: dir, stdio: "inherit" });
for (const entry of [path.join(dir, "consumer.ts"), path.join(installed, "dist/rendering/geometry.worker.js"), path.join(installed, "dist/geo/routeSurface.worker.js")]) {
  const output = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" });
  assert.ok(output.outputFiles[0].contents.length > 0);
}
const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
assert.equal(manifest.name, "@upsight/map-renderer");
assert.equal(manifest.version, sourceManifest.version);
assert.equal(pack.filename, `upsight-map-renderer-${manifest.version}.tgz`);
if (options["pack-destination"]) {
  const destination = path.resolve(options["pack-destination"]);
  const isOutsideWorkspace = directory => {
    const relative = path.relative(realpathSync(workspace), directory);
    return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
  };
  assert.ok(isOutsideWorkspace(destination), "Package output must be outside the repository.");
  mkdirSync(destination, { recursive: true });
  assert.ok(isOutsideWorkspace(realpathSync(destination)), "Package output must be outside the repository.");
  copyFileSync(path.join(dir, pack.filename), path.join(destination, pack.filename));
  console.log(`Verified package: ${path.join(destination, pack.filename)}`);
}
console.log(`Types and browser/worker bundles passed. ${pack.entryCount} files, ${(pack.size / 1024).toFixed(0)} KB packed. Artifact: ${path.join(dir, pack.filename)}`);

// The optional browser check uses sample map data. Serve the directory printed below to open it locally.
if (options.browser) {
  const smoke = path.join(dir, "browser-smoke");
  mkdirSync(smoke);
  writeFileSync(path.join(dir, "browser.ts"), `
import { Map as LibreMap } from 'maplibre-gl';
import { SceneStore, DEFAULT_STYLE, LabelLayer, LiveEventLayer } from '@upsight/map-renderer';
import { MapLibreConnection } from '@upsight/map-renderer/maplibre';
import { depotExtension } from './node_modules/@upsight/map-renderer/examples/depotExtension.js';
const status = document.querySelector('#status');
const selection = document.querySelector('#selection');
const container = document.querySelector('#map');
const map = new LibreMap({ container, center: [103.85,1.3], zoom: 18.5, pitch: 55,
  style: {version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#edf1ed'}}]} });
map.once('load', () => {
  const store = new SceneStore();
  const base = { source:'demo',properties:{},style:DEFAULT_STYLE };
  store.execute({ type:'upsert',features:[
    {...base,id:'demo:building',layer:'buildings',label:'Building',model:{kind:'building'},
      style:{...DEFAULT_STYLE,height:14,color:'#a8bbc5'},
      geometry:{type:'Polygon',coordinates:[[[103.8497,1.3],[103.8499,1.3],[103.8499,1.3002],[103.8497,1.3002]]]}},
    {...base,id:'demo:road',layer:'roads',label:'Road',model:{kind:'road'},
      style:{...DEFAULT_STYLE,width:7,height:0,elevation:0,color:'#71777b'},
      geometry:{type:'LineString',coordinates:[[103.8495,1.29985],[103.8505,1.29985]]}},
    {...base,id:'demo:depot',layer:'custom:depots',label:'Partner depot',
      model:{kind:'custom',rendererId:'depot',heading:0},style:{...DEFAULT_STYLE,width:18,height:8,color:'#087f8c'},
      geometry:{type:'Point',coordinates:[103.85015,1.3001]}},
    {...base,id:'demo:label',layer:'annotations',label:'Partner depot',model:{kind:'label'},
      style:{...DEFAULT_STYLE,elevation:10},geometry:{type:'Point',coordinates:[103.85015,1.3001]}}
  ]});
  const connection = MapLibreConnection.fromMap(map);
  const renderer = connection.attach(store, {
    extensions:[depotExtension],
    createGeometryWorker:() => new Worker(new URL('./geometry.worker.js',import.meta.url),{type:'module'}),
    onStats:s => { status.textContent = (s.triangles > 0 && s.geometryMode === 'worker' ? 'READY' : 'Loading') +
      ' · ' + s.geometryMode + ' · ' + s.triangles + ' triangles · ' + s.drawCalls + ' draws'; },
    onError:e => { status.textContent = 'ERROR: '+e; },
  });
  const select = id => { renderer.select(id); selection.textContent = id ? id +
    (store.isEditable(id) ? '' : ' · provider-owned observation') : 'Nothing selected'; };
  const input = connection.bindInput((x,y) => select(renderer.pick(x,y)),() => {});
  const labels = new LabelLayer(container,store,renderer,select);
  const live = new LiveEventLayer(store, {
    id:'fixture-traffic', label:'Synthetic traffic check', attribution:'Synthetic test data'
  });
  const trafficStatus = document.querySelector('#traffic-status');
  const offTraffic = live.subscribe(state => {
    trafficStatus.textContent = 'Synthetic traffic: ' + state.events.length + ' active · ' +
      state.source.status + (state.events.length ? ' · expires after 8 seconds' : ' · expired automatically');
  });
  document.querySelector('#traffic').onclick = () => {
    const now = Date.now();
    live.apply({schemaVersion:1,observedAt:new Date(now).toISOString(),
      expiresAt:new Date(now+8000).toISOString(),events:[
        {id:'accident',kind:'accident',label:'Synthetic accident',message:'Test fixture only. No real incident or routing restriction.',
          geometry:{type:'Point',coordinates:[103.8498,1.29985]}},
        {id:'slow',kind:'slow-traffic',label:'Synthetic slow traffic',message:'Test fixture only. No measured speed or ETA impact.',
          geometry:{type:'LineString',coordinates:[[103.85,1.29985],[103.8504,1.29985]]}}
      ]});
  };
  document.querySelector('#rotate').onclick = () => store.execute({type:'upsert',
    features:store.transformSelection('demo:depot',0,0,30)});
  document.querySelector('#undo').onclick = () => store.undo();
  document.querySelector('#dispose').onclick = () => {
    offTraffic(); live.dispose(); trafficStatus.textContent = 'Synthetic traffic: disposed';
    input.dispose(); labels.dispose(); renderer.dispose(); connection.dispose();
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = 'Disposed · host map retained';
  };
});
`);
  await build({ entryPoints: [path.join(dir, "browser.ts")], bundle: true, outfile: path.join(smoke, "main.js"),
    format: "esm", platform: "browser", logLevel: "silent" });
  await build({ entryPoints: [path.join(installed, "dist/rendering/geometry.worker.js")], bundle: true,
    outfile: path.join(smoke, "geometry.worker.js"), format: "esm", platform: "browser", logLevel: "silent" });
  writeFileSync(path.join(smoke, "maplibre.css"), readFileSync(path.join(dir, "node_modules/maplibre-gl/dist/maplibre-gl.css")));
  // MapLibre's worker imports its shared module. Keep both beside main.js.
  for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
    copyFileSync(path.join(dir, "node_modules/maplibre-gl/dist", file), path.join(smoke, file));
  }
  copyFileSync(path.join(dir, "node_modules/maplibre-gl/LICENSE.txt"), path.join(smoke, "LICENSE.txt"));
  writeFileSync(path.join(smoke, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Packed renderer integration check</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="maplibre.css"><style>body{margin:0;font:16px system-ui;background:#edf1ed}#map{height:100vh}
aside{position:absolute;z-index:2;top:16px;left:16px;padding:18px;max-width:calc(100vw - 68px);background:white;border-radius:8px}
h1{font-size:19px;margin:0 0 12px}p{font-size:13px}button{padding:8px;margin-right:4px}</style>
<div id="map"></div><aside><h1>Packed renderer integration check</h1><p>Synthetic fixtures · installed npm archive</p>
<p id="status">Loading</p><p id="selection">Nothing selected</p><button id="rotate">Rotate depot</button>
<button id="undo">Undo</button><button id="dispose">Dispose renderer</button>
<p id="traffic-status">Synthetic traffic: not started · no live traffic data</p>
<button id="traffic">Show synthetic traffic (8s)</button></aside><script type="module" src="main.js"></script></html>`);
  console.log(`Browser fixture (serve over localhost): ${smoke}`);
}
