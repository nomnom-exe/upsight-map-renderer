Upsight Map Renderer
====================

A TypeScript library for drawing and editing buildings, roads, routes, labels
and GLB models with Babylon.js. Applications supply the geographic data and
can attach the renderer to an existing MapLibre map.

The package is framework-independent. The host application supplies map data,
routing, model storage and UI.

Documentation
-------------

.. list-table:: Guides and examples
   :header-rows: 1
   :widths: 35 65

   * - Topic
     - Reference
   * - Display a map and a building
     - `MapLibre quickstart <examples/basicMap.ts>`_
   * - Use Babylon without MapLibre
     - `Standalone quickstart <examples/standaloneMap.ts>`_
   * - Find methods, parameters and import paths
     - `API guide <docs/API.rst>`_
   * - Supply server data and preserve edits
     - `Data and refresh guide <docs/DATA.rst>`_
   * - Add GLB models
     - `Partner models <examples/partnerModels.ts>`_
   * - Render a new object type
     - `Custom depot extension <examples/depotExtension.ts>`_

The quickstarts use a synthetic building.

Install
-------

Use Node.js 22 or later, npm 10 or 11, and a browser bundler that supports ES
modules and worker URLs.

Prebuilt package
~~~~~~~~~~~~~~~~

Install version ``0.1.0``::

    npm install https://github.com/nomnom-exe/upsight-map-renderer/releases/download/v0.1.0/upsight-map-renderer-0.1.0.tgz

The prebuilt package includes compiled JavaScript, types and workers. npm installs
its runtime dependencies without Git preparation or a local TypeScript build.
For MapLibre integration::

    npm install https://github.com/nomnom-exe/upsight-map-renderer/releases/download/v0.1.0/upsight-map-renderer-0.1.0.tgz maplibre-gl@6.10.0

Commit ``package.json`` and ``package-lock.json``. Use ``npm ci`` for repeatable
installs and import the library as ``@upsight/map-renderer``.

Use the attached ``.tgz`` package, not GitHub's automatic source ZIP or tarball.
For npm 12, enable URL dependencies with ``allow-remote=root`` in the application's
``.npmrc``; see `npm installation settings <https://docs.npmjs.com/cli/v12/commands/npm-install/#allow-remote>`_.

Source installation
~~~~~~~~~~~~~~~~~~~

This option requires Git and builds the library locally::

    npm install git+https://github.com/nomnom-exe/upsight-map-renderer.git

npm installs build dependencies and compiles the library before installing it.
This takes longer than a prebuilt package installation.

If your application also needs MapLibre, install both in one command::

    npm install git+https://github.com/nomnom-exe/upsight-map-renderer.git maplibre-gl@6.10.0

MapLibre is optional. Commit ``package.json`` and ``package-lock.json`` and use
``npm ci`` for reproducible installs. Import the package as ``@upsight/map-renderer``.

The Git installation runs the package's ``prepare`` script. Do not disable
scripts for this install. npm 12 also requires permission for Git
dependencies and lifecycle scripts; see the
`npm installation settings <https://docs.npmjs.com/cli/v12/commands/npm-install/>`_.

The package is not published to an npm registry.

MapLibre example
----------------

Copy `examples/basicMap.ts <examples/basicMap.ts>`_ into the application source.
The example creates a MapLibre map with a selectable 8-metre building.
Set the container dimensions and import MapLibre's CSS:

.. code-block:: html

    <div id="map" style="width: 100%; height: 500px"></div>

.. code-block:: typescript

    import 'maplibre-gl/dist/maplibre-gl.css';
    import { createBasicMap } from './basicMap.js';

    const lifetime = new AbortController();
    const view = await createBasicMap(
      document.getElementById('map')!,
      'https://tiles.openfreemap.org/styles/liberty',
      lifetime.signal,
    );

    // Call when your page or component closes.
    function disposeMap() {
      lifetime.abort();
      view.dispose();
    }

The example places one building at ``[103.80015, 1.3001]``. Additional buildings
require feature data from the host application. Replace the OpenFreeMap style URL
as needed and retain source attribution.

Standalone example
------------------

For a standalone scene, copy `examples/standaloneMap.ts <examples/standaloneMap.ts>`_
and use a canvas instead:

.. code-block:: html

    <canvas id="scene" style="width: 100%; height: 500px"></canvas>

.. code-block:: typescript

    import { createStandaloneMap } from './standaloneMap.js';

    const view = createStandaloneMap(
      document.getElementById('scene') as HTMLCanvasElement,
    );

    // Call when the view closes.
    function disposeMap() {
      view.dispose();
    }

The standalone example has mouse, touch and keyboard controls without a basemap.
The renderer handles resizing and schedules frames on demand. Change the view
with ``view.camera.setView(...)`` or ``view.camera.firstPerson(...)``.

Examples are source templates, not package-root exports. For React or Next.js,
initialize once after mounting and dispose in effect cleanup, including pending
startup. Load rendering modules in a browser-only entry point when using SSR.
See the `API guide <docs/API.rst>`_ for lifecycle methods and worker setup.

Package archive
---------------

To share a built file without requiring Git in the consuming app, clone the
source and build an archive::

    git clone https://github.com/nomnom-exe/upsight-map-renderer.git
    cd upsight-map-renderer
    npm ci
    npm test
    npm pack --pack-destination ..

``npm pack`` builds JavaScript and TypeScript declarations, then writes
``upsight-map-renderer-0.1.0.tgz`` outside the source folder. The archive includes
compiled code, guides and examples.

Copy that archive to your application folder, then run::

    npm install ./upsight-map-renderer-0.1.0.tgz

A GitHub source ZIP or tarball does not contain the compiled ``dist`` folder.
Use the Git installation command above or build and pack the source first.

Camera configuration
--------------------

* With an existing MapLibre map, use ``MapLibreConnection`` from
  ``@upsight/map-renderer/maplibre``. MapLibre owns that map's camera and input.
* For a standalone canvas, use ``MapCamera`` from
  ``@upsight/map-renderer/engine/MapCamera`` and ``BabylonRenderer`` from
  ``@upsight/map-renderer/babylon``. Optional ``MapControls`` from
  ``@upsight/map-renderer/engine/MapControls`` adds mouse, touch and keyboard input.
  Give the canvas a visible CSS width and height, ``tabIndex=0`` and
  ``touch-action: none``. Dispose the controls and renderer when the view closes.

Update a standalone camera through ``setView()`` or ``firstPerson()``;
the camera does not observe mutations to arrays passed earlier.

Draw a building
---------------

Call this function in the browser with a loaded MapLibre map using Mercator
projection and flat ground. Coordinates are longitude then latitude. Height is
in metres.

.. code-block:: typescript

    import { applyFeatureEnvelope, DEFAULT_STYLE, SceneStore } from '@upsight/map-renderer';
    import { MapLibreConnection } from '@upsight/map-renderer/maplibre';
    import type { Map as MapLibreMap } from 'maplibre-gl';

    export function drawBuilding(map: MapLibreMap) {
      const store = new SceneStore();
      applyFeatureEnvelope(store, {
        schemaVersion: 1,
        source: { id: 'example', label: 'Sample building', status: 'snapshot', attribution: 'Synthetic example' },
        features: [{
          id: 'example:building', source: 'example', layer: 'buildings', label: 'Sample building',
          geometry: {
            type: 'Polygon',
            coordinates: [[[103.8, 1.3], [103.8003, 1.3], [103.8003, 1.3002],
                           [103.8, 1.3002], [103.8, 1.3]]],
          },
          style: { ...DEFAULT_STYLE, height: 8 },
          model: { kind: 'building', family: 'industrial' },
          properties: {},
        }],
      });
      const connection = MapLibreConnection.fromMap(map);
      const renderer = connection.attach(store, {});
      return {
        store,
        renderer,
        dispose() {
          renderer.dispose();
          connection.dispose();
        },
      };
    }

Centre the map at ``[103.80015, 1.3001]``. The returned handle exposes the store,
renderer and ``dispose()``. The host retains ownership of the MapLibre map
passed to ``fromMap`` and must remove it separately.

Edit and remove objects
-----------------------

The following example moves the building 10 metres east, rotates it 15 degrees
and scales it by 1.2. It uses the store returned by a quickstart or ``drawBuilding``.
Related parts are edited together when group metadata and all members are loaded.

.. code-block:: typescript

    export function editBuilding(store: SceneStore) {
      const features = store.transformSelection('example:building', 10, 0, 15, 1.2);
      store.execute({ type: 'upsert', features });
      store.undo();
      store.redo();
    }

    export function removeBuilding(store: SceneStore) {
      const ids = store.requireSelection('example:building').map(feature => feature.id);
      store.execute({ type: 'remove', ids });
    }

``requireSelection`` rejects an incomplete or protected building group before
editing. For drag interactions, call ``store.beginSelectionPreview(id)`` on
pointer down, call ``preview.move(east, north)`` with the total displacement
from the start of the drag, then call ``preview.finish(true)`` on drop or
``preview.finish(false)`` to cancel. A completed drag creates one undo step.

The host UI connects pointer events to these methods. Use ``renderer.pick(x, y)``
with canvas-relative CSS pixels to find an object and ``renderer.select(id)``
to highlight it. With MapLibre, pause its map gestures while dragging an object.

Save edits with ``store.exportScenario()`` and restore them with
``store.importScenario(text)``. The package also provides ``connectScenePersistence``
and ``localSceneStorage`` for browser storage. Source refreshes preserve local
overrides; saved scenarios contain edits and model IDs, not GLB files or a full
copy of the source dataset.

This assumes stable source and feature IDs. Overrides are not a field-by-field
merge with newer upstream features. A source refresh can cancel an active drag;
committed edits remain separate. See the `data guide <docs/DATA.rst>`_ for group
membership conflicts, missing features and refresh ownership.

Add models and extensions
-------------------------

* `Partner models <examples/partnerModels.ts>`_ shows how to register a static,
  self-contained GLB, supply its bytes to the renderer and place editable
  instances at map coordinates. Embed PNG or JPEG textures and export triangle
  meshes. The loader checks the 20 MiB file limit and the 64 MiB decoded asset
  budget before loading. Your application stores the original model files.
  Base-colour textures can use ``TEXCOORD_0`` through ``TEXCOORD_5``; the model
  must contain the selected UV set. Texture scale, rotation and offset are kept.
  Rendering is static and uses a simplified material pipeline, not every glTF
  animation or PBR material effect. The `API guide <docs/API.rst>`_ lists the limits.
* `Depot extension <examples/depotExtension.ts>`_ shows how to draw and pick a
  custom object using the renderer's extension API.

The example files are integration templates: copy the relevant example into
your application and adapt its storage and UI. They are not root package exports.
Supply a ``resolveAsset`` callback when attaching the renderer. Register the
model bytes before restoring saved placements, and use a new asset ID when
replacing a model file so cached instances can distinguish the versions.

A charger can use the built-in model or a supplied GLB. Pass edited coordinates
to routing and scoring services to apply charger movements to their results.

Routes, labels and events
-------------------------

* ``routeFeature`` converts supplied route data into a scene feature.
  ``RoutePlayback`` samples the route for vehicle animation; the host connects
  playback to its renderer and camera.
* ``RoadSurfaceIndex`` and ``RouteSurfaceResolver`` match a supplied route to
  road evidence. They can hide underground or ambiguous spans. They do not
  calculate a route or prove that a destination entrance is accessible.
* ``LabelLayer`` places screen labels. ``LiveEventLayer`` maintains supplied
  incidents and their expiry. The host fetches live events and decides how
  they affect routing or arrival estimates.
* ``applyFeatureEnvelope`` and ``fromGeoJSON`` accept geographic data from the host.

Supply and refresh data
-----------------------

.. code-block:: text

    Server or file -> host provider -> GeoFeature data -> SceneStore -> renderer
    Host UI        -> committed local edits -----------> SceneStore

Use ``applyFeatureEnvelope`` for a complete provider source update and
``store.execute`` for a local edit. **A source update replaces that source's
entire base dataset.** If your server returns separate tiles, aggregate the tiles
you want to keep before replacing the source; publishing each tile as the same
source would remove the previous tile's base features.

The library does not decode raw OSM PBF, OSM XML or vector-tile PBF files.
Your provider converts them into the documented feature contract. See the
`data and refresh guide <docs/DATA.rst>`_ for the input contract, complete source
updates, stable identities and preserved local overrides.

Performance and troubleshooting
-------------------------------

Load bounded areas, cancel obsolete requests and reuse the renderer while panning.
Use stable IDs and detail appropriate to the zoom level. Limit model counts,
triangles and texture sizes. Workers handle geometry generation; GPU rendering
and buffer uploads still require profiling on target devices.

``RendererOptions.onStats`` reports geometry mode, draw calls, triangles, buffer
bytes and CPU timings. The mobile quality profile uses smaller budgets. The
`API guide <docs/API.rst>`_ explains the renderer options and their limits.

.. list-table:: Common setup problems
   :header-rows: 1
   :widths: 30 70

   * - Symptom
     - Check
   * - Missing compiled imports
     - Use the Git install command with lifecycle scripts enabled, or a built archive. A GitHub source ZIP has no compiled ``dist``.
   * - Blank or tiny canvas
     - Give the container nonzero CSS width and height, initialize after mounting, and check WebGL support and ``onError``.
   * - Building is missing
     - Check longitude/latitude order, camera position, height, layer visibility and validation errors. Basemap buildings do not automatically become scene features.
   * - Buildings disappear when another tile loads
     - Aggregate your resident tiles before replacing a source. See the data guide's snapshot rules.
   * - DOM errors during SSR
     - Load and initialize rendering modules in browser code after mounting.
   * - Worker URL fails
     - Check the bundler and CSP. MapLibre's worker and Babylon geometry workers have separate entry points; see ``Workers`` in the API guide.
   * - GLB is rejected
     - Read the validation error and check embedded resources, supported geometry/materials and budgets in the API guide.
   * - Saved models do not appear
     - Restore the model bytes under the saved asset IDs. Scenario JSON contains placements, not GLB files.
   * - An edited building changes membership upstream
     - Inspect ``buildingRefreshConflicts()`` and let the host resolve it. Do not reset all user edits automatically.

Contribute and verify
---------------------

Fork the repository, create a branch and make your change. Run these commands
in the renderer repository before opening a pull request::

    npm ci
    npm test
    npm run build
    npm run verify

``npm run verify`` checks archive and Git installations, imports, TypeScript
declarations, browser/worker bundles and packaged documentation. It also typechecks
and bundles the quickstart examples. Tests remain in the repository and are
excluded from the package archive.

``npm run verify -- --archive-only`` checks the prebuilt package without repeating
the Git installation. Add ``--pack-destination <directory>`` to copy the verified
archive to a directory outside the repository.

Include an example or regression test for a behaviour change. Keep existing
imports and method signatures compatible, and explain any change that requires
consumer applications to update. A maintainer reviews contributions before
merging. GitHub Actions runs the checks on Windows and Linux.

To update a consuming app, install the new version's release URL, then review and
commit its manifest and lockfile changes. Source installations can select a commit
or tag by appending ``#<commit-sha>`` or ``#<tag>`` to the Git URL.
Keep archives, screenshots, logs and local settings out of commits.

Release a prebuilt package
------------------------------

On ``main``, update the version in ``package.json`` and ``package-lock.json``
together, then push the reviewed commit and a matching tag such as ``v0.1.1``.

The release workflow runs tests, builds the package and verifies its installation,
types and worker bundles. It attaches the verified ``.tgz`` to a GitHub Release.
Compiled files and archives stay outside the source repository.

Consumers commit their updated manifest and lockfile. Publish a new version for
subsequent releases; do not replace an existing release asset.

`Source <https://github.com/nomnom-exe/upsight-map-renderer>`_ |
`Report an issue <https://github.com/nomnom-exe/upsight-map-renderer/issues>`_ |
`Pull requests <https://github.com/nomnom-exe/upsight-map-renderer/pulls>`_ |
`Build checks <https://github.com/nomnom-exe/upsight-map-renderer/actions>`_
