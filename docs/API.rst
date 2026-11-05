Renderer API guide
==================

`Setup <../README.rst>`_ |
`MapLibre example <../examples/basicMap.ts>`_ |
`Standalone example <../examples/standaloneMap.ts>`_ |
`Data inputs <DATA.rst>`_

.. contents:: On this page
   :local:
   :depth: 2

Imports and coordinates
-----------------------

.. code-block:: typescript

    import {
      SceneStore, DEFAULT_STYLE, applyFeatureEnvelope,
      type GeoFeature, type FeatureEnvelopeV1, type RendererHandle,
    } from '@upsight/map-renderer';
    import { MapLibreConnection } from '@upsight/map-renderer/maplibre';
    import { BabylonRenderer } from '@upsight/map-renderer/babylon';
    import { MapCamera } from '@upsight/map-renderer/engine/MapCamera';
    import { MapControls } from '@upsight/map-renderer/engine/MapControls';

Import the browser renderer and MapLibre integration only in browser code.
The root entry supplies scene data, editing and supporting APIs. The optional
``/maplibre`` entry requires the application's ``maplibre-gl`` dependency.

* Geographic positions use WGS84 ``[longitude, latitude]``, for example
  ``[103.8, 1.3]``.
* Heights, elevations, widths, radii and movement distances use metres.
  Elevation is relative to the host scene's reference level, not automatically
  surveyed height above sea level.
* Camera bearings and headings use degrees clockwise from north. Camera pitch
  uses degrees. Use the camera methods to change its view; mutating an input
  array later does not move the camera.
* Picking, projection and ground conversion use canvas-relative **CSS pixels**.
  Subtract the canvas rectangle's ``left`` and ``top`` from a pointer's client
  coordinates. Do not multiply them by device pixel ratio.

Features and source updates
---------------------------

A ``GeoFeature`` describes one scene object. The renderer builds and caches
its geometry.

.. list-table:: Feature fields
   :header-rows: 1
   :widths: 23 77

   * - Field
     - Meaning
   * - ``id``
     - Stable, scene-wide unique object ID. Use a namespace such as ``city:building-42``.
   * - ``source``
     - Provider ID, such as ``city`` or ``chargers``. All features in a source update must use its ID.
   * - ``layer``
     - Visibility category: ``buildings``, ``roads``, ``chargers``, ``route``, ``scenario``, ``imported``, ``landscape``, ``annotations`` or ``custom:name``.
   * - ``label``
     - Human-readable name. A label field alone does not create visible screen text.
   * - ``geometry``
     - ``Point``, ``LineString`` or ``Polygon`` in geographic coordinates. A polygon's first ring is its outside boundary; later rings are holes.
   * - ``style``
     - Required ``color``, ``height``, ``radius``, ``width`` and ``elevation``. Start with ``DEFAULT_STYLE`` and override relevant values.
   * - ``model``
     - Optional drawing recipe. Set an explicit kind such as ``building``, ``road``, ``charger`` or ``asset``.
   * - ``properties``
     - Small metadata record of strings, finite numbers, booleans or null. Nested objects and arrays are not supported here.

``applyFeatureEnvelope(store, envelope)`` validates a version 1 envelope and
replaces the source's complete base dataset:

.. code-block:: typescript

    const envelope: FeatureEnvelopeV1 = {
      schemaVersion: 1,
      source: {
        id: 'partner-sites',
        label: 'Partner sites',
        status: 'snapshot',
        attribution: 'Your data attribution',
        asOf: '2026-11-06T00:00:00Z',
      },
      features: [], // Replace with the complete currently retained set for this source.
    };
    applyFeatureEnvelope(store, envelope);

``status`` is ``live``, ``stale``, ``snapshot`` or ``local``. ``asOf`` is optional
and describes the data's observation time, not a timer managed by the library.

Omitted features are removed from the source's base data. Aggregate retained
tiles before applying a source update; envelopes do not append or patch data.
An empty feature array clears the source's base features.

Use stable feature IDs between refreshes so saved local edits still refer to
the same objects. Base refreshes preserve committed overrides and deletions.
A source refresh cancels any active drag preview for that source without
committing it.

``FeatureProvider`` is an optional interface for host-provided loaders:

.. code-block:: typescript

    interface FeatureProvider {
      load(query: {
        bounds: { west: number; south: number; east: number; north: number };
        zoom: number;
        signal: AbortSignal;
      }): Promise<FeatureEnvelopeV1>;
    }

The host calls the loader, cancels obsolete requests and applies results.
The renderer does not fetch source data.

For GeoJSON, ``fromGeoJSON(input, source?)`` returns ``{ info, features }``.
Apply it with ``store.replaceSource(result.info, result.features)``. It accepts
a WGS84 Feature or FeatureCollection and splits multi-geometries into separate
features. OSM tag conversion is not included.
Supply stable GeoJSON IDs when refreshing imports; array positions are the
fallback when IDs are absent.

Source: `feature types <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/types.ts>`_,
`provider contract <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/provider.ts>`_,
`GeoJSON adapter <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/adapters.ts>`_.

Building and road recipes
~~~~~~~~~~~~~~~~~~~~~~~~~

For a building polygon, ``style.elevation`` is the bottom of that part and
``style.height`` is its vertical extent. Separate elevated parts can leave a
passage beneath them. Polygon holes describe courtyards or openings through
the footprint. Parts, elevations and holes must be supplied explicitly.

``model.family`` selects a building treatment such as residential, industrial
or canopy. ``model.roof`` supplies a supported shape, height and colour, plus
orientation when known.

For a road line, ``model.road`` can carry lane/pavement/sidewalk flags,
``surfaceHidden``, and per-vertex ``elevations`` and ``nodeIds``. Both arrays
must follow the road's vertex order. With an elevation profile, the road base
is each supplied height plus ``style.elevation - 0.18`` metres; using a style
elevation of 0.18 preserves the supplied base heights. Without a profile,
``style.elevation`` sets the base. The asphalt surface has a small drawing offset.

For a route or annotation line, ``model.line.elevations`` are direct heights
relative to the scene reference and replace the scalar style elevation.
``widths`` has one value per vertex; ``segmentMask`` has one boolean per edge.
False masks leave gaps. Keep road-level ordering separate from measured metres;
an OSM ``layer`` number is not an elevation measurement.

Source: `height conventions <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/elevations.ts>`_.

Scene editing and undo
----------------------

Use ``replaceSource`` or ``applyFeatureEnvelope`` for provider refreshes. Use
``execute`` for user edits that should be saved and undone. Do not mutate a
feature returned by the store; validated features are frozen.

.. list-table:: SceneStore methods
   :header-rows: 1
   :widths: 42 58

   * - Call
     - Result or effect
   * - ``new SceneStore(options?)``
     - Create independent scene state. Options can reserve read-only IDs/sources and supply override validation/resolution hooks.
   * - ``get(id)`` / ``values()`` / ``size``
     - Read one object, the combined scene records, or their count. Records combine provider data and local edits; hidden renderer layers are still in the store.
   * - ``sourceInfo()``
     - Read provider metadata and attribution.
   * - ``replaceSource(info, features)``
     - Replace one provider's base features while keeping local overrides. Prefer the envelope API for network responses.
   * - ``execute({ type: 'upsert', features })``
     - Add or replace local objects as one undoable command.
   * - ``execute({ type: 'remove', ids })``
     - Hide existing objects through local deletion overrides. It does not delete provider records on the server.
   * - ``undo()`` / ``redo()``
     - Move through committed edit history. ``canUndo`` and ``canRedo`` support UI buttons. History retains up to 40 past states.
   * - ``resetOverrides(ids)``
     - Remove local edits and reveal the current provider values. Resets all pinned parts if an ID belongs to an edited building group.
   * - ``clearScenario()``
     - Clear all local overrides and building pins; provider data remains. This is itself undoable.
   * - ``isOverridden(id)``
     - Check whether an object has a local replacement or deletion.
   * - ``isEditable(id)`` / ``protectSource(source)``
     - Check provider protection, or reserve a read-only provider namespace for the store's lifetime. Reserve it before loading saved edits.
   * - ``subscribe(listener)``
     - Receive ``{ reason, revision, ids }`` changes. Reason is ``source``, ``preview`` or ``commit``. Returns an unsubscribe function.

``isEditable`` does not check whether a full building is loaded; use
``canEditSelection`` for an editor action. Low-level ``execute`` validates the
command, but it does not automatically collect related building parts.
Selection and editing operate on features and verified building groups.
Mesh-level editing is not supported.

Move, rotate or resize a selection:

.. code-block:: typescript

    // 10 metres east, 2 metres north, a 15-degree rotation, 1.2 times the size.
    const moved = store.transformSelection('city:building-42', 10, 2, 15, 1.2);
    store.execute({ type: 'upsert', features: moved });

    const ids = store.requireSelection('city:building-42').map(f => f.id);
    store.execute({ type: 'remove', ids });
    store.undo(); // Restore the removed selection.

``transformSelection`` returns changed records; it does not commit them.
For a height-only change to a building group, call
``resizeBuildingHeight(store.requireSelection(id), heightMetres)`` from the root
entry, then commit the returned features with ``execute``.

Drag previews commit as one undo step:

.. code-block:: typescript

    const preview = store.beginSelectionPreview(selectedId);
    preview.move(3, 0);
    preview.move(7, 2); // Total displacement from pointer-down, not another 7 metres.
    preview.finish(true); // Drop: create one undo step.
    // Use preview.finish(false) instead when cancelling a drag.

``preview.transform(east, north, angle?, scale?)`` also supports rotation and
uniform scaling from the original selection. The host connects pointer events,
pointer cancellation and gesture locking. Pause map gestures during object
dragging and restore their previous enabled state afterward.

Building groups and refreshed data
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The provider identifies verified groups using these fields on every part:

.. code-block:: typescript

    properties: {
      buildingGroup: 'relation-1234',
      buildingGroupBasis: 'osm-building-relation',
      buildingGroupMembers: 3,
    }

Grouping applies to ``model.kind: 'building'`` and is scoped by source ID.
``buildingGroupBasis`` records the provider's evidence; the renderer does not
verify OSM relations or infer membership from neighbouring footprints. All
members must have matching metadata to edit the whole group.

* ``building(id)`` returns its loaded members, bounds, centre, height and
  completeness, or undefined if the object is not a recognised group.
* ``selectionMembers(id)`` returns the loaded group members, or the one object.
* ``canEditSelection(id)`` checks that the selection exists, is editable and
  contains the expected group members.
* ``requireSelection(id)`` throws if that check fails. Use it before group
  deletion or other operations which must include every part.

A whole-building edit saves the known membership in a building pin. If a
refresh reports additional parts, those new parts are kept in base data but
hidden at the building's old location while the pinned edit remains active.
``buildingRefreshConflicts()`` reports observed membership changes, including
saved/incoming IDs and whether the incoming group is complete. The host decides
whether to keep or reset the edit; identity migration is not automatic.
Conflict detection is limited to loaded data.

Save and restore
~~~~~~~~~~~~~~~~

``exportScenario()`` returns JSON containing committed overrides, deletion
markers and building pins. ``importScenario(text, options?)`` restores that
format. Base data, edit history and GLB bytes are excluded.
``history: false`` clears undo history when importing; ``include`` restores a
selected partition of edits.

.. code-block:: typescript

    import { connectScenePersistence, localSceneStorage } from '@upsight/map-renderer';

    const disconnect = connectScenePersistence(
      store,
      localSceneStorage(window.localStorage, 'partner-map-edits-v1'),
      { onError: error => console.error(error.message) },
    );
    // On unmount: disconnect();

``connectScenePersistence`` loads the saved scenario and saves subsequent
commits synchronously.
Provider refreshes and drag previews do not trigger saves. If loading fails,
the connection preserves the existing save and disables subsequent writes.
Storage quotas can also fail; handle ``onError`` in the host UI.

The storage interface is ``{ load(): string | null; save(value: string): void }``.
For an asynchronous database, the host must load/save around this interface or
use explicit export/import; the interface does not await promises. Persistence
partitions cannot split a pinned building group. Routing and scoring must read
the edited data to reflect local edits.

Source: `SceneStore <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/SceneStore.ts>`_,
`building groups <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/buildingGroups.ts>`_,
`persistence <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/persistence.ts>`_.

Renderer and camera controls
----------------------------

``connection.attach(store, options)`` and
``new BabylonRenderer(canvas, camera, store, options?)`` provide a
``RendererHandle``. A connection supports one active renderer.

.. list-table:: RendererHandle
   :header-rows: 1
   :widths: 42 58

   * - Call
     - Result or effect
   * - ``pick(x, y)``
     - Return an object ID or null at a canvas-relative CSS pixel.
   * - ``select(idOrNull)``
     - Highlight the chosen object/group, or clear highlighting. This does not alter the store's data.
   * - ``project(position, elevation?)``
     - Convert a geographic point to a CSS pixel position, or null when it cannot be projected.
   * - ``screenToGround(x, y)``
     - Intersect the screen ray with reference ground. Returns a geographic position or null; it does not pick a building roof or terrain surface.
   * - ``getViewport()``
     - Return the current viewport snapshot, or null before it is ready. Includes centre, zoom, size, bounds and ground-corner intersections.
   * - ``setLayerVisible(layer, visible)``
     - Toggle a renderer layer without deleting features. The MapLibre handle always hides ``landscape`` and ignores toggles for it; a standalone renderer can show it. DOM labels have separate visibility controls.
   * - ``setVehicle(poseOrNull)``
     - Set the built-in route vehicle's ``position``, ``bearing``, ``visible`` and optional ``elevation``. Use a GLB feature for a custom vehicle model.
   * - ``subscribeFrame(listener)``
     - Run after renderer frames; returns an unsubscribe function. It is not an always-running animation timer.
   * - ``dispose()``
     - Release the renderer's scene resources, listeners and worker.

``RendererOptions`` accepts ``createGeometryWorker``, ``resolveAsset``,
``extensions``, ``quality``, ``onStats``, ``onError`` and ``onAssetReady``.
Supply ``onError`` to surface failed models and worker/graphics problems.
``onAssetReady(assetId, ready)`` reports asset loading results.

By default, the renderer tries a module worker for geometry. A bundler-specific
``createGeometryWorker: () => Worker | null`` lets the host choose its worker
URL. Returning null uses bounded main-thread work instead. The worker entry is
``@upsight/map-renderer/geometry.worker.js``. Confirm ``onStats`` reports
``geometryMode: 'worker'`` in the deployed application.

``onStats`` reports feature, triangle, draw-call, cache, upload and CPU timings,
plus the selected quality profile and detail level. CPU timings do not measure
GPU frame rate. ``quality`` accepts a full ``RenderQuality`` record; the
automatic device profile is the default.

MapLibre ownership
~~~~~~~~~~~~~~~~~~

``MapLibreConnection.fromMap(map)`` attaches to an existing loaded MapLibre map.
The host owns the map and must call ``map.remove()`` during cleanup.
Use Mercator projection and flat ground; globe and terrain-draped integration
are not provided by this connection.

``await MapLibreConnection.create(container, center, signal, { style, workerUrl? })``
creates and owns a MapLibre map. ``style`` is its style URL. This helper disables
MapLibre's built-in attribution control, so the host must display the required
data attribution. Aborting startup removes the partially created map.

* ``connection.camera`` and ``connection.canvas`` expose that map's camera
  interface and canvas.
* ``setRendererVisible(false)`` stops custom drawing and picking while keeping
  geometry cached. It does not stop the host's feature-data requests.
* ``setBasemapEnabled(false)`` removes the basemap's sources and style layers.
  This is supported only for maps created by ``create``. An external map's
  owner controls its style. It does not stop unrelated application fetches.
* ``bindInput(onPick, onInteract)`` returns gesture handlers and a cleanup
  function. It connects clicks and user camera movement, not object dragging.
* ``connection.dispose()`` detaches its renderers/listeners and removes a map
  it created. A map passed to ``fromMap`` remains open.

Standalone ownership
~~~~~~~~~~~~~~~~~~~~

``new MapCamera(center)`` provides an independent map camera without MapLibre.
Pass it to ``BabylonRenderer`` and optionally to
``new MapControls(canvas, camera, onPick, onInteract)``. Give the canvas an explicit
CSS size, ``tabIndex = 0`` and ``touch-action: none``.

Both camera paths expose ``setView({ center, zoom, pitch, bearing })`` with
partial updates, ``firstPerson(center, bearing, surfaceElevation?)``,
``fitBounds(bounds)``, ``pan(fromX, fromY, toX, toY)``,
``zoomAt(delta, x?, y?)``, ``project``, ``screenToGround``, ``snapshot`` and
``subscribe``. ``firstPerson`` sets the view once; the host supplies updated
vehicle positions and headings during playback.

``MapControls`` supports ``enable()``, ``disable()``, ``isEnabled()`` and
``dispose()``. Dispose controls and renderer when the view closes.

Source: `renderer interface <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/rendering/types.ts>`_,
`MapLibre connection <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/engine/MapLibreConnection.ts>`_,
`camera interface <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/engine/CameraView.ts>`_,
`quality settings <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/rendering/quality.ts>`_.

Workers
-------

The three worker entry points require separate URLs:

* The renderer's **geometry worker** builds mesh buffers for supplied features.
* The **route-surface worker** matches supplied routes to road evidence for
  ``RouteSurfaceResolver``.
* **MapLibre's worker** handles map sources and tile processing for MapLibre.

The renderer and route resolver try module workers with
``new URL('./worker-file.js', import.meta.url)`` by default. Some bundlers copy
and rewrite those URLs automatically; others leave them pointing at a missing
file or do not bundle the worker's imports. Verify worker URLs in deployment.
Copying an unbundled worker file alone is insufficient because it imports
other library modules.

Bundle renderer workers
~~~~~~~~~~~~~~~~~~~~~~~

For hosts whose bundler does not handle those worker URLs, install esbuild in
the consuming application::

    npm install --save-dev esbuild

Create ``scripts/build-renderer-workers.mjs`` in that application:

.. code-block:: javascript

    import { build } from 'esbuild';
    import { fileURLToPath } from 'node:url';

    await build({
      entryPoints: {
        'geometry.worker': fileURLToPath(import.meta.resolve(
          '@upsight/map-renderer/geometry.worker.js')),
        'routeSurface.worker': fileURLToPath(import.meta.resolve(
          '@upsight/map-renderer/routeSurface.worker.js')),
      },
      outdir: 'public/renderer-workers',
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    });

Run it from the application's root, after installing the renderer::

    node scripts/build-renderer-workers.mjs

This writes ``geometry.worker.js`` and ``routeSurface.worker.js``. The example
assumes the host serves ``public`` files from its site root, as Next.js and Vite
normally do. For a different static directory or base path, adjust the output
directory and browser URLs together. Add the command
to the host build process so deployments regenerate workers from the installed
renderer version.

In browser code:

.. code-block:: typescript

    import { RouteSurfaceResolver, type RendererOptions } from '@upsight/map-renderer';

    const options: RendererOptions = {
      createGeometryWorker: () => new Worker(
        '/renderer-workers/geometry.worker.js', { type: 'module' }),
    };
    const surfaceResolver = new RouteSurfaceResolver(new Worker(
      '/renderer-workers/routeSurface.worker.js', { type: 'module' }));

Pass ``options`` to ``connection.attach(store, options)`` or the standalone
renderer constructor. ``RouteSurfaceResolver`` accepts a worker **instance**,
not a factory callback. Call ``surfaceResolver.dispose()`` when finished; the
renderer disposes its own geometry worker through ``renderer.dispose()``.

Allow these worker URLs in the host's Content Security Policy and serve them
as JavaScript rather than a fallback HTML page. Keep the worker code and main
renderer on the same package version. ``onStats`` should report
``geometryMode: 'worker'``. An unexpected main-thread fallback indicates a
worker setup or runtime failure.

Serve MapLibre's worker separately
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

For MapLibre GL 6.10.0, ``maplibre-gl-worker.mjs`` imports its sibling
``maplibre-gl-shared.mjs``. Both files must be served from the same directory.
If the bundler does not copy them automatically, add the following to the
host build script, including the package licence:

.. code-block:: javascript

    import { copyFile, mkdir } from 'node:fs/promises';

    await mkdir('public/maplibre', { recursive: true });
    for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
      await copyFile(`node_modules/maplibre-gl/dist/${file}`, `public/maplibre/${file}`);
    }
    await copyFile('node_modules/maplibre-gl/LICENSE.txt', 'public/maplibre/LICENSE.txt');

Set its browser URL **before** creating a MapLibre map:

.. code-block:: typescript

    import { setWorkerUrl } from 'maplibre-gl';
    setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

Alternatively, pass that URL as ``workerUrl`` to
``MapLibreConnection.create``. It affects MapLibre's worker only; it does not
configure either renderer worker. Copy files from the installed MapLibre
version. The MapLibre CSS import is still required separately.

GLB models and charging stations
--------------------------------

`partnerModels.ts <../examples/partnerModels.ts>`_ demonstrates GLB byte
registration, placement and ``resolveAsset``. Its ``createPartnerModels`` helper
is not a package export.

The renderer calls an ``AssetResolver`` of this shape:

.. code-block:: typescript

    type AssetResolver = (assetId: string) => Promise<Uint8Array>;

The host maps a stable ID, such as ``partner:van-v1``, to bytes from an upload,
IndexedDB, its server or another permitted source. A persisted feature stores
this ID, never an expiring blob URL. Register or make the bytes available before
restoring placements. Use a new ID when replacing the model file, and retain
bytes needed by saved placements or undo.

An imported object uses point geometry with
``model: { kind: 'asset', assetId, length, heading }``. ``length`` is the target
length of the longest horizontal side, in metres, with proportions preserved.
``style.elevation`` places its base relative to scene ground;
``style.color: '#ffffff'`` preserves the model's base colours without extra tint.

A charger can use a built-in model with ``model.kind: 'charger'``, or reference
a GLB through the same kind plus ``assetId``. Use ``layer: 'chargers'`` and point
geometry. Charger model sizing uses ``style.height`` (0.1–20 metres). Add,
move and delete chargers with scene commands.

``inspectGLB(arrayBuffer)`` validates a file and returns ``{ triangles, meshes }``
or throws. ``MAX_GLB_BYTES`` is available from the root entry.

.. list-table:: Current model limits
   :header-rows: 1
   :widths: 31 69

   * - Item
     - Supported input
   * - File
     - Self-contained GLB 2.0, at most 20 MiB. Buffers and textures must be embedded.
   * - Geometry
     - Static triangle meshes; at most 200,000 triangles, 128 meshes/material sections and 512 nodes. Repeated mesh nodes count toward the triangle budget.
   * - Texture format
     - Embedded PNG or JPEG. At most 16 images/textures, each dimension no larger than 4096, and a combined budget of 4,194,304 texture pixels.
   * - Decoded resources
     - Estimated decoded budget of 64 MiB. Passing the file-size limit alone is insufficient. The asset layer also limits visible decoded resources.
   * - UV coordinates
     - Base-colour textures can select ``TEXCOORD_0`` through ``TEXCOORD_5``; the selected set must exist. Texture scale, rotation and offset are retained.
   * - Excluded formats/features
     - Separate ``.gltf`` resources, external URLs, skins, morph targets, Draco/Meshopt compression and compressed WebP/AVIF/BasisU texture extensions are not supported.

The asset renderer uses a map shader for base colour, texture and lighting,
with limited glTF PBR material support. Imported animation groups are stopped.
Use a custom extension for other material or animation pipelines.

Source: `asset validation <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/assets/validation.ts>`_,
`asset rendering <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/rendering/AssetLayer.ts>`_.

Routes and vehicle playback
---------------------------

``RouteData`` contains ``positions``, ``durationSeconds``, ``distanceMetres`` and
``source``. Optional node IDs/pairs, elevations, widths and segment masks retain
road evidence. The host obtains this record from its routing service.

* ``routeFeature(route, routeId?)`` returns a validated scene feature. It does
  not fetch or calculate the route. Add it as provider data or a scenario edit,
  according to the application's ownership policy.
* ``new RoutePlayback()`` supports ``setRoute(route, preserveProgress?)``,
  ``play()``, ``pause()``, ``seek(progress)``, ``setSpeed(multiplier)``,
  ``tick(elapsedSeconds)``, ``ahead(metres)``, ``clear()`` and ``subscribe``.
  Progress is 0–1 and speed is 0.25–100. The host supplies elapsed time, usually
  from its own animation loop, and cancels that loop on unmount.
* Playback state includes position, bearing, elevation, progress and
  ``surfaceVisible``. ``clear()`` emits null. Use that flag to hide a vehicle on
  intentionally hidden spans, and null to remove it through ``setVehicle``.
* ``new RouteSampler(positions, elevations?, segmentMask?)`` provides distance-
  based ``sample(progress)`` without a playback clock.
* ``new FollowHeading()`` smooths headings with ``sample(bearing, timeMs)``.
  Pass a monotonic timestamp such as ``performance.now()`` and ``reset()`` when
  starting a new follow session. It does not control a camera by itself.

``new RoadSurfaceIndex(roads, origin).resolve(route)`` synchronously matches a
route against supplied road geometry. ``RouteSurfaceResolver`` provides the
worker-backed path: call ``setRoads(roads, origin)``, then
``resolve(route, resultCallback)``. It keeps only the newest waiting request.
``cancel()`` invalidates pending results; ``dispose()`` also terminates its worker.

The resolver updates drawing heights, widths and visibility using available
road evidence. It does not reroute, prove bridge clearance, determine entrance
access or infer tunnel depth from an OSM ``layer`` number. Unsupported or
ambiguous segments can be hidden. On worker failure or oversized main-thread
fallback, the result marks spans ``limited`` and hidden rather than reusing
stale heights. Inspect ``segmentStates`` and ``surfaceMatch`` in the host UI.

Source: `route types <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/types.ts>`_,
`playback <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/engine/RoutePlayback.ts>`_,
`surface resolver <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/RouteSurfaceResolver.ts>`_.

Labels and live events
----------------------

``new LabelLayer(container, store, renderer, onSelect, limit?)`` draws plain-text
DOM labels for point features with ``model.kind: 'label'``. Supply a positioned
container aligned with the map canvas. Labels avoid overlap within their limit
(80 by default, at most 200). They draw above 3D objects and are not depth-tested.

Use ``setVisible``, ``setLayerVisible`` and ``dispose`` on the label layer.
Changing a renderer layer's visibility alone does not change this separate DOM
layer. ``groupAnnotations(points, width, height, cell?)`` is a separate utility
that groups screen points into grid cells; it does not create label UI.

``new LiveEventLayer(store, { id, label, attribution })`` reserves one read-only
source namespace. ``apply(snapshot)`` accepts a full version 1 snapshot with
``observedAt``, ``expiresAt`` and ``events``. Each event has a stable ``id``,
``kind``, ``label``, ``message`` and point or line geometry.

* Kinds: ``accident``, ``slow-traffic``, ``closure``, ``road-work`` and ``advisory``.
* Point events require a ``LabelLayer`` for display. Line events become renderer
  line features. Both use ``custom:traffic``.
* ``apply`` returns false for an older or equal observation time. Invalid input
  throws without replacing the scene. Snapshots allow at most 2,000 events and
  10,000 total vertices, with a freshness window of at most 24 hours.
* The layer expires events automatically. ``events()``, ``getState()`` and
  ``subscribe(listener)`` expose current data. ``dispose()`` stops the timer
  and removes its features; its source remains protected for that store's life.
* Optional ``impact`` requires provider-confirmed road IDs and direction. A
  ``delay`` includes ``delaySeconds``; a ``closure`` has no duration.
  The host decides whether this evidence changes routes, scores or arrival times.

The host handles feed connections and routing integration.

Source: `labels <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/rendering/LabelLayer.ts>`_,
`live event contract <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/LiveEventLayer.ts>`_.

Custom renderer extensions
--------------------------

Use a GLB for a new static model when possible. For a new drawing behaviour,
register a ``RendererExtensionFactory`` in ``RendererOptions.extensions`` and
set the feature's ``model`` to ``{ kind: 'custom', rendererId: factory.id }``.

See `depotExtension.ts <../examples/depotExtension.ts>`_ for a complete example.

The factory has a unique ``id`` and ``create({ scene, store, invalidate })``.
Its returned extension implements:

.. list-table:: Extension lifecycle
   :header-rows: 1
   :widths: 30 70

   * - Method
     - Responsibility
   * - ``sync(changes)``
     - Update only changed objects. An undefined value means the object was removed or no longer belongs to this extension.
   * - ``render(frame)``
     - Use the supplied viewport/camera matrix, hidden layers and selected ID. Place local metre geometry in Mercator world coordinates before applying the matrix.
   * - ``pick(x, y, width, height)``
     - Optional. These extension arguments use drawing-buffer pixels, unlike RendererHandle's CSS-pixel API. Return an owned ID and non-negative hit distance in Mercator units, or null.
   * - ``dispose()``
     - Release all meshes, materials, textures, observers and other resources the extension created.

Call ``invalidate()`` when asynchronous work changes the extension's output.
An extension that throws during sync, rendering or picking is disabled and
reported through ``onError`` so other extensions can continue. A factory failure
during creation fails renderer setup. Extensions run as trusted application
code without sandboxing.

Source: `extension interfaces <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/rendering/extensions.ts>`_.

Validation and accuracy limits
------------------------------

``validateFeature(feature)`` returns a normalized, frozen feature or throws.
Source replacement and scene commands already call it. Catch validation errors
around uploads and network updates.

* Geographic latitude is limited to -85 through 85 degrees. Split shapes that
  span more than 2 degrees on either axis or cross the antimeridian.
* A line has 2–10,000 points. A polygon has 1–16 rings, each with 3–512 distinct
  vertices. Closed and unclosed rings are accepted; duplicate closing points
  are normalized. Self-intersections, intersecting rings and nested holes are
  rejected.
* Colours use ``#RRGGBB``. Height is 0–1,000 metres, radius/width 0.2–100 metres,
  and feature elevation -1,000–1,000 metres. Model-specific restrictions also
  apply; see the source types and validator.
* Supported roof recipes are flat, gabled, hipped, pyramidal and skillion.
  Non-flat geometry requires suitable footprint and height/direction evidence;
  unsupported combinations fall back to a flat top.
* Scenario JSON is limited to 2,000,000 JavaScript string characters and 10,000
  imported override entries. Keep GLB bytes in separate asset storage.
* A combined scene is limited to 25,000 features and 500,000 vertices, with at
  most 10,000 local overrides. Limit retained data to the relevant viewport.

``auditScene(features, { maxOperations?, maxIssues?, clearanceMetres? })``
returns ``{ issues, operations, truncated }`` without changing geometry. It
flags duplicate footprints, incomplete groups and possible road obstructions
within a bounded amount of work. It is a diagnostic aid, not a complete collision
test or a guarantee that a route is safe or a building is correctly mapped.

Source: `feature validation <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/validation.ts>`_,
`roof generation <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/rendering/models/roofs.ts>`_,
`scene diagnostics <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/diagnostics.ts>`_.
