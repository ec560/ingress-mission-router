# IITC Mission Route Planner

Mission Route Planner turns portals inside your IITC Draw Tools areas into an
ordered Ingress mission route. It previews the route on the map, splits it into
missions, and exports a JSON plan for UMM 0.7.3.

The planner helps you compare and organize a route; it cannot confirm that a
portal or path is publicly accessible. Always review the finished route on the
map before submitting or walking it.

## What you need

- [IITC](https://iitc.app/)
- Draw Tools 0.12.1 enabled in IITC
- A userscript manager such as Violentmonkey or Tampermonkey
- Ultimate Mission Maker (UMM) with its UMM Opt importer when you are ready to
  use the exported plan
- An [openrouteservice API key](https://account.heigit.org/) only if you want
  pedestrian routing

## Installation

1. Install IITC and enable Draw Tools.
2. Open the
   [raw userscript](https://raw.githubusercontent.com/ec560/ingress-mission-router/master/ingress-mission-router.user.js)
   and approve the installation in your userscript manager.
3. Reload `intel.ingress.com` and open **Mission Route Planner** from the IITC
   toolbox.

The userscript has no build step.

## Plan your first route

1. Use Draw Tools to draw a polygon, rectangle, or circle around the portals
   you want. Lines and markers do not define a scan area.
2. Open **Mission Route Planner** and choose **Scan drawn areas**.
3. Check the portal list. Uncheck anything that should not be part of the route.
4. For a first attempt, leave **Routing mode** set to **Straight-line estimate**
   and leave the start and finish on **Automatic**.
5. Enter the number of missions. Every mission needs at least six distinct
   portals.
6. Add the banner name and mission description, then choose **Optimize route**.
7. Review the colored route, portal order, route summary, and any warnings on
   the map.
8. Choose **Export UMM JSON**, back up any existing UMM plan, then use
   **UMM Opt > Choose file** to import the download.

### If portals are missing

The planner can only collect named portals that IITC has loaded. Pan and zoom
across the entire drawn area, wait for the portals to appear, and scan again.
Multiple drawn areas are combined. Scanning again updates the collection to the
current areas without removing portals that are still inside them.

## Choose a routing mode

| Mode | Best for | What the preview means |
| --- | --- | --- |
| **Straight-line estimate** | Fast drafts and areas where you already know the paths | Uses geographic distance and the 30 m portal interaction range. It is not a walkable street route and can cross buildings, water, or restricted land. |
| **Pedestrian paths** | Checking a route against mapped footpaths | Sends the selected coordinates to openrouteservice and draws its walking geometry. Unmapped access near a portal may still be estimated. |

Straight-line mode is fully offline. Pedestrian mode requires an
[openrouteservice API key](https://account.heigit.org/); the key stays in the
page until the tab is reloaded. The selected portal coordinates are sent to
openrouteservice only when pedestrian mode is used.

### Pedestrian options

**Visit portals when within 30 m** adjusts the visit order when the fetched
walking path passes within interaction range of a later portal. It keeps a
chosen start and finish and does not make additional API requests.

**Prefer less backtracking** compares alternative orders that retrace less of
the route. In pedestrian mode it may accept up to 20% more walking distance,
checks up to five alternatives, and makes extra route requests. In straight-line
mode it only discourages sharp reversals.

openrouteservice chooses the mapped paths. The planner then optimizes where the
route can interact with portals within 30 m. Nearby portals may share an
interaction location, so check that the physical approach is sensible.

## Mission and route options

- **Start portal / Finish portal:** Leave either on **Automatic**, or anchor the
  route where your banner should begin or end.
- **Maximize banner length:** Chooses the largest possible multiple of six
  missions—6, 12, 18, and so on—while keeping at least six distinct portals in
  every mission.
- **Share endpoints between missions:** Uses the last portal of one mission as
  the first portal of the next. That portal counts in both missions and can make
  a longer banner possible.
- **Return to the starting portal:** Makes the route a loop and adds the first
  portal as the final waypoint of the last mission. This return does not count
  as a new distinct portal.

Without automatic maximization, the planner splits the selected portals as
evenly as possible across the requested mission count.

## Review and debug a route

Do not export based on the distance alone. Use the map and summary together:

- **Colored links** show the exported portal visit order. Each color represents
  one mission.
- **Solid grey lines** show mapped pedestrian geometry.
- **Dashed grey lines** show straight-line estimates used where a mapped walking
  path could not be used.
- Portal tooltips show their visit number, mission membership, shared endpoints,
  loop start/finish, and off-path warnings.
- The status area reports the mission sizes, distance, estimated moving time,
  route options that affected the result, and anything that needs review.

When the route looks wrong, work through this checklist:

1. **Missing portal:** Pan until it loads in IITC, then scan again.
2. **Unwanted portal:** Uncheck it and optimize again.
3. **Wrong start or finish:** Select the required endpoint instead of Automatic.
4. **Line crosses an impossible area:** Straight-line mode does not know about
   streets or barriers. Switch to pedestrian mode or verify the route manually.
5. **Dashed walking segment:** The portal was at least 40 m from a mapped path,
   or openrouteservice could not snap it. Verify access carefully; that segment's
   distance and time are estimates.
6. **Unexpected return or mission boundary:** Check the shared-endpoint and
   return-to-start options, then optimize again.
7. **Settings changed after optimization:** Optimize again before exporting.

### Common messages

| Message | What to do |
| --- | --- |
| **Draw an area first** | Add a polygon, rectangle, or circle with Draw Tools. |
| **At least 6 portals in every mission** | Select more portals or reduce the mission count. |
| **Invalid API key / access denied (401 or 403)** | Check the key in your openrouteservice account and confirm that the public API is enabled for it. |
| **Quota or rate limit reached (429)** | Wait for the service quota to recover, then optimize again. |
| **No walking connection** | Exclude the named disconnected portal or split the plan into a smaller area. |
| **30 m interaction optimization could not connect…** | The mapped legs were kept. Inspect the named transition on the map and adjust the selection if it is not walkable. |

## Limits and accuracy

- Exact visit-order optimization is used for up to 16 portals. Larger routes use
  a multi-start heuristic, so the result is not proof of the globally shortest
  route.
- Straight-line mode supports up to 600 selected portals. Pedestrian mode
  supports up to 300.
- Walking requests are deliberately spaced and large selections may take
  several minutes.
- A portal at least 40 m from the nearest mapped walking path uses straight-line
  estimates until the route returns to path-accessible portals.
- Moving-time estimates for straight-line fallback segments assume 1.4 m/s and
  do not include stops, terrain, crossings, or access restrictions.

## Session data, caching, and privacy

The portal collection, API key, and walking caches exist only in the current
page. Reloading clears them. **Clear collection** also clears the collected
portals and cached walking data.

During the current page session, a cancelled pedestrian calculation can reuse
completed distance batches when you retry the same portal selection. Changing
the selection may require new proximity, distance, and geometry requests.

Straight-line mode makes no external routing requests. In pedestrian mode,
portal coordinates are processed by
[openrouteservice](https://openrouteservice.org/) using data from
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

## UMM export

Exports use UMM 0.7.3 `fileFormatVersion` 2 and create a new JSON download. The
planner does not modify UMM plans or Draw Tools layers. Every exported waypoint
uses the `HACK_PORTAL` objective; review and edit the plan in UMM before mission
submission.
