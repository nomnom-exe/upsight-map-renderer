Upsight Map Renderer
====================

A TypeScript library for drawing and editing buildings, roads, routes, labels
and GLB models with Babylon.js. Applications supply the geographic data and
can attach the renderer to an existing MapLibre map.

Build and install
-----------------

With Node.js 22 or later, run these commands in the renderer repository::

    npm ci
    npm test
    npm pack

Copy the resulting archive to your application and install it::

    npm install ./upsight-map-renderer-0.1.0.tgz @babylonjs/core@9.27.1 @babylonjs/loaders@9.27.1

For the MapLibre integration, also install ``maplibre-gl@6.10.0``.
Use a browser bundler that supports ES modules and worker URLs.

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
      return () => {
        renderer.dispose();
        connection.dispose();
      };
    }

Centre the map near the depot at ``[103.80015, 1.3001]`` to see it. Call the
returned function when the map view closes.

Add models and extensions
-------------------------

* `Partner models <examples/partnerModels.ts>`_ shows how to register a static,
  self-contained GLB, supply its bytes to the renderer and place editable
  instances at map coordinates. Embed PNG or JPEG textures and export triangle
  meshes. The loader checks the 20 MiB file limit and the 64 MiB decoded asset
  budget before loading. Your application stores the original model files.
* `Depot extension <examples/depotExtension.ts>`_ shows how to draw and pick a
  custom object using the renderer's extension API.

For a change to the shared library, open a pull request with an example or
test that demonstrates the behaviour. Run ``npm test`` and ``npm run verify``
to check the library and install its archive in a separate consumer.
