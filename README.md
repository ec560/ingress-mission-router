# IITC Mission Route Planner

Mission Route Planner is a small IITC userscript that collects named portals
inside Draw Tools areas, orders them into missions, and exports a UMM 0.7.3
JSON plan.

## Installation

1. Install [IITC](https://iitc.app/) and enable Draw Tools 0.12.1.
2. Install `ingress-mission-router.user.js` with a userscript manager such as
   Violentmonkey or Tampermonkey.
3. Reload `intel.ingress.com` and open **Mission Route Planner** in the IITC
   toolbox.

The plugin has no build step and requests no browser permissions beyond the
page it runs on.

## Straight-line workflow

Draw a polygon, rectangle, or circle with Draw Tools, choose **Scan drawn
areas**, select the portals and mission count, then choose **Optimize route**.
Straight-line mode is offline and uses geographic distance estimates. Choose a
start/end portal when needed, review the route on the map, and select **Export
UMM JSON**. Import the downloaded file through UMM Opt.

Scan again after panning or zooming to add more named portals. Collection lasts
until the page is reloaded; unnamed loading placeholders are ignored.

## Pedestrian workflow

Select **Pedestrian paths** and provide an openrouteservice API key. The key is
kept only in page memory until reload, and selected coordinates are sent to
openrouteservice. Walking mode checks mapped paths, requests foot-walking
distances and geometry, and uses straight-line estimates for portals at least
40 m from a mapped path. Up to 300 portals are supported; large selections
make multiple requests and can take several minutes.

The optional **Visit portals as you pass them** and **Reduce backtracking**
options refine the route using the fetched geometry. A warning is shown when a
portal uses an estimate. Verify physical access on the map before exporting.

## Limits, caching, and privacy

- Exact ordering is used for up to 16 portals; larger selections use a
  heuristic. The result is not a proof of a globally shortest walk.
- Walking requests are spaced conservatively and completed matrix batches are
  reused when the same selection is retried after cancellation.
- Use **Clear collection** to remove the current portal set and cached walking
  data. Reloading the page also clears the key, collection, and caches.
- Portal coordinates are sent to openrouteservice only in pedestrian mode.
  Straight-line mode makes no external requests.

## UMM compatibility

Exports use UMM 0.7.3 `fileFormatVersion` 2. The plugin does not modify UMM
plans or Draw Tools layers; it creates a new JSON download for review and
import.

## License and attribution

Walking directions are provided by
[openrouteservice](https://openrouteservice.org/) using
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
