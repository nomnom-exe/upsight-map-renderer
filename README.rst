Upsight Map Renderer
====================

A TypeScript library for drawing and editing buildings, roads, routes, labels
and GLB models with Babylon.js. Applications supply the geographic data and
can attach the renderer to an existing MapLibre map.

Each application creates its own scene and camera. The library provides the
rendering and editing code; it does not share camera state between applications.
The host application supplies map data, routing, model storage and its UI.

Install
-------

Use Node.js 22 or later, npm 10 or 11, and Git. Run this in your application::

    npm install git+https://github.com/nomnom-exe/upsight-map-renderer.git

npm downloads the source, builds the library and installs its required
dependencies, including Babylon.js and Earcut. You do not need to clone the
repository, build an archive or create an npm account.

If your application also needs MapLibre, install both in one command::

    npm install git+https://github.com/nomnom-exe/upsight-map-renderer.git maplibre-gl@6.10.0

MapLibre is optional. Keep your application's ``package.json`` and
``package-lock.json`` in Git. Teammates then run ``npm ci`` to install the same
renderer commit and dependency versions. Import the library as
``@upsight/map-renderer`` in your code.

The Git installation runs the package's ``prepare`` script. Do not disable
scripts for this install. npm 12 also requires permission for Git
dependencies and lifecycle scripts; see the
`npm installation settings <https://docs.npmjs.com/cli/v12/commands/npm-install/>`_.

Use a browser bundler that supports ES modules and worker URLs.
The package is distributed through GitHub, not an npm registry.

Build an archive instead
------------------------

To share a built file without requiring Git in the consuming app, clone the
source and build an archive::

    git clone https://github.com/nomnom-exe/upsight-map-renderer.git
    cd upsight-map-renderer
    npm ci
    npm test
    npm pack --pack-destination ..

``npm pack`` builds the JavaScript and TypeScript declarations. The command
above writes ``upsight-map-renderer-0.1.0.tgz`` outside the source folder.
It does not publish anything to a registry.

Copy that archive to your application folder, then run::

    npm install ./upsight-map-renderer-0.1.0.tgz

A GitHub source ZIP or tarball does not contain the compiled ``dist`` folder.
Use the Git installation command above or build and pack the source first.

Choose a camera
---------------

* With an existing MapLibre map, use ``MapLibreConnection`` from
  ``@upsight/map-renderer/maplibre``. MapLibre owns that map's camera and input.
* For a standalone canvas, use ``MapCamera`` from
  ``@upsight/map-renderer/engine/MapCamera`` and ``BabylonRenderer`` from
  ``@upsight/map-renderer/babylon``. Optional ``MapControls`` from
  ``@upsight/map-renderer/engine/MapControls`` adds mouse, touch and keyboard input.
  Give the canvas a visible CSS width and height, ``tabIndex=0`` and
  ``touch-action: none``. Dispose the controls and renderer when the view closes.

Each camera instance belongs to its host application. Change a standalone
camera through ``setView()`` or ``firstPerson()``. Changing an array previously
passed to the camera does not move it.

Draw a building
---------------

Call this function in the browser with a loaded MapLibre map using Mercator
projection and flat ground. Coordinates are longitude then latitude. Height is
in metres.

.. code-block:: typescript

    import { applyFeatureEnvelope, DEFAULT_STYLE, SceneStore } from '@upsight/map-renderer';
    import { MapLibreConnection } from '@upsight/map-renderer/maplibre';
    import type { Map as MapLibreMap } from 'maplibre-gl';

    export function drawDepot(map: MapLibreMap) {
      const store = new SceneStore();
      applyFeatureEnvelope(store, {
        schemaVersion: 1,
        source: { id: 'sites', label: 'Sites', status: 'snapshot', attribution: 'Example data' },
        features: [{
          id: 'sites:depot', source: 'sites', layer: 'buildings', label: 'Depot',
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

Centre the map near the depot at ``[103.80015, 1.3001]`` to see it. Keep the
returned handle to access its store and renderer. Call ``handle.dispose()``
when the map view closes. The MapLibre map passed to ``fromMap`` remains
owned by your application.

Edit and remove objects
-----------------------

Use the store returned by ``drawDepot``. This moves the depot 10 metres east,
rotates it 15 degrees and scales it by 1.2. Related building parts are edited
together when their group metadata is supplied and the full group is loaded.

.. code-block:: typescript

    export function editDepot(store: SceneStore) {
      const features = store.transformSelection('sites:depot', 10, 0, 15, 1.2);
      store.execute({ type: 'upsert', features });
      store.undo();
      store.redo();
    }

    export function removeDepot(store: SceneStore) {
      const ids = store.requireSelection('sites:depot').map(feature => feature.id);
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

Add models and extensions
-------------------------

* `Partner models <examples/partnerModels.ts>`_ shows how to register a static,
  self-contained GLB, supply its bytes to the renderer and place editable
  instances at map coordinates. Embed PNG or JPEG textures and export triangle
  meshes. The loader checks the 20 MiB file limit and the 64 MiB decoded asset
  budget before loading. Your application stores the original model files.
  Base-colour textures can use ``TEXCOORD_0`` through ``TEXCOORD_5``; the model
  must contain the selected UV set. Texture scale, rotation and offset are kept.
* `Depot extension <examples/depotExtension.ts>`_ shows how to draw and pick a
  custom object using the renderer's extension API.

The example files are integration templates: copy the relevant example into
your application and adapt its storage and UI. They are not root package exports.
Supply a ``resolveAsset`` callback when attaching the renderer. Register the
model bytes before restoring saved placements, and use a new asset ID when
replacing a model file so cached instances can distinguish the versions.

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
* ``applyFeatureEnvelope`` and ``fromGeoJSON`` accept host-provided geographic
  data. The package does not download a country map or charging feed itself.

Contribute and verify
---------------------

Fork the repository, create a branch and make your change. Run these commands
in the renderer repository before opening a pull request::

    npm ci
    npm test
    npm run build
    npm run verify

``npm run verify`` tests both archive and Git installation in temporary apps.
The Git check starts with source files only and verifies that npm builds the
library and installs its required dependencies. The checks also cover imports,
TypeScript declarations and browser/worker bundles. Tests remain in this
repository and are not shipped in the package archive.

Include an example or regression test for a behaviour change. Keep existing
imports and method signatures compatible, and explain any change that requires
consumer applications to update. A maintainer reviews contributions before
merging. GitHub Actions runs the checks on Windows and Linux.

After an accepted update, rerun the Git installation command or install a new
archive in the consuming app, then review and commit its dependency and lockfile
changes. Existing installations do not update automatically. To select a
specific renderer release, append ``#<commit-sha>`` or ``#<tag>`` to the Git URL.
Keep archives, screenshots, logs and local settings out of commits.

`Source <https://github.com/nomnom-exe/upsight-map-renderer>`_ |
`Report an issue <https://github.com/nomnom-exe/upsight-map-renderer/issues>`_ |
`Pull requests <https://github.com/nomnom-exe/upsight-map-renderer/pulls>`_ |
`Build checks <https://github.com/nomnom-exe/upsight-map-renderer/actions>`_
