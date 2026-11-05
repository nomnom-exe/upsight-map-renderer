Data inputs and updates
=======================

`Setup <../README.rst>`_ | `API reference <API.rst>`_

Supply normalized ``GeoFeature`` records through ``FeatureEnvelopeV1``.
The host application handles data retrieval and persistence.

Responsibilities
----------------

.. list-table:: Service boundaries
   :header-rows: 1
   :widths: 25 75

   * - Owner
     - Responsibility
   * - Data service
     - Retrieve and normalize source data, preserve identities and serve geographic queries.
   * - Host application
     - Load the visible area, combine chunks, show attribution, connect editing controls and persist changes.
   * - Renderer library
     - Validate features, maintain scene state and overrides, build geometry, render and handle selection.
   * - Routing or scoring service
     - Calculate routes and recommendations using effective station positions and incident data.

Source formats
--------------

Convert raw OSM nodes, ways, relations and tags into feature records before loading.
Preserve available footprints, building parts, heights, openings, road levels and
group metadata. Handle missing or conflicting source values in the provider.

MapLibre renders the OpenFreeMap basemap separately. Supply ``GeoFeature`` records
for Babylon objects; basemap tiles are not automatically added to the scene.

Raw OSM PBF and vector-tile PBF use different schemas despite sharing the ``.pbf``
extension. Decode either format in the provider before creating a feature envelope.

Provider contract
-----------------

The public contract is declared in
`provider.ts <https://github.com/nomnom-exe/upsight-map-renderer/blob/main/src/geo/provider.ts>`_:

.. code-block:: typescript

    import type { Extent, FeatureEnvelopeV1 } from '@upsight/map-renderer';

    interface FeatureProvider {
      load(query: {
        bounds: Extent;
        zoom: number;
        signal: AbortSignal;
      }): Promise<FeatureEnvelopeV1>;
    }

Import ``FeatureProvider`` from the package to implement this interface.
Return ``{ schemaVersion: 1, source, features }``. ``source`` contains ``id``,
``label``, ``status`` and ``attribution``, with an optional ISO timestamp ``asOf``.
Positions use WGS84 ``[longitude, latitude]``; heights and distances use metres.
See the `API reference <API.rst>`_ for feature fields and examples.

``applyFeatureEnvelope(store, envelope)`` validates the envelope and replaces
the entire base set for its source. Aggregate and deduplicate resident chunks
before applying an update. Omitted base features are removed from that source.
Keep the combined set within the store's limits.

Cancel obsolete requests and discard late responses from earlier views. Cache by
dataset revision, query and detail level. Keep each snapshot on one revision and
retain the previous scene if a request fails.

Preserve local edits across updates
-----------------------------------

The store separates provider base features from committed local overrides:

.. code-block:: text

    Latest base features + saved local overrides = effective scene

Keep feature IDs stable across refreshes. For OSM data, preserve element type and
ID with stable identifiers for parts. Avoid dates, tile numbers and array positions
in IDs. A changed ID creates a new feature and does not inherit existing overrides.

Default store behaviour:

* Committed edits win over the provider feature as a whole; this is not a
  field-by-field merge of newer upstream values.
* Local removals remain as overrides, preventing the same feature from reappearing
  after a source refresh.
* Edited features can remain visible when absent from the new base set.
  A viewport response cannot establish whether a feature was deleted upstream.
* A source update can cancel an uncommitted drag preview while retaining
  committed overrides.
* Verified complete-group edits record the building membership they edited.
  Later observed membership changes can be reported by
  ``store.buildingRefreshConflicts()``. Only observed changes are reported;
  the host resolves conflicts.

Resolve conflicts by retaining edits, resetting affected overrides or migrating
them explicitly. Custom store policies can change the default merge behaviour.

Save committed edits with ``exportScenario`` / ``importScenario`` or the persistence
helpers. Store GLB bytes separately and supply an asset resolver when restoring.
Routing and scoring must consume effective coordinates and removals to reflect
charger edits.
