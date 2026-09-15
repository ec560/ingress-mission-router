// ==UserScript==
// @name         IITC plugin: Mission Route Planner
// @namespace    opayc.ingress.mission-router
// @version      0.10.0
// @description  Route loaded portals inside Draw Tools areas and export UMM 0.7.3 JSON.
// @match        https://intel.ingress.com/*
// @grant        none
// ==/UserScript==

/* Install alongside IITC and Draw Tools 0.12.1. Open Mission Route Planner in
 * the toolbox. Draw a polygon, rectangle or circle, scan, choose portals and
 * mission count, optimize, then export. Import through UMM Opt > Choose file.
 * Walking mode uses openrouteservice foot-walking distances and route geometry.
 * An ORS API key is required (kept in page memory only). Coordinates go to ORS.
 * Exact visit order for <=16 portals under the returned matrix, heuristic above.
 * ORS chooses the paths; this is not a proof of the globally shortest walk.
 * Network snapping is limited to 30m; review access between paths and portals.
 * Only loaded named portals are collected. Scan again after panning/zooming
 * to accumulate more portals. Collection persists only until page reload.
 * Export uses UMM 0.7.3 fileFormatVersion 2 (verified against its source at
 * https://umm.8bitnoise.rocks/plugin/iitc-ultimate-mission-maker.user.js).
 * No changes are made to UMM data or Draw Tools layers by this plugin.
 */
(function () {
  'use strict';
  function wrapper() {
    if (typeof window.plugin !== 'function') window.plugin = function () {};
    if (window.plugin.missionRouter) return;
    const p = window.plugin.missionRouter = {};
    p.pool = new Map();
    p.excluded = new Set();
    p.route = null;
    p.busy = false;
    p.walkCache = null;
    const rad = Math.PI / 180;
    p.distance = (a, b) => {
      const x = Math.sin((a.lat - b.lat) * rad / 2);
      const y = Math.sin((a.lng - b.lng) * rad / 2);
      return 12742000 * Math.asin(Math.sqrt(Math.min(1,
        x * x + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * y * y)));
    };
    // Longitude unwrapping also supports areas spanning the date line.
    p.inRing = (point, ring) => {
      let inside = false;
      const unwrap = lng => ((lng - point.lng + 540) % 360) - 180;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = unwrap(ring[j].lng), ay = ring[j].lat - point.lat;
        const bx = unwrap(ring[i].lng), by = ring[i].lat - point.lat;
        if (Math.abs(ax * by - bx * ay) < 1e-10 && ax * bx + ay * by <= 0) return true;
        if ((ay > 0) !== (by > 0) && 0 < (bx - ax) * (-ay) / (by - ay) + ax) inside = !inside;
      }
      return inside;
    };
    p.inPolygon = (point, rings) => {
      if (!rings.length) return false;
      if (typeof rings[0].lat === 'number') return p.inRing(point, rings);
      if (rings[0].length && typeof rings[0][0].lat === 'number') {
        return p.inRing(point, rings[0]) && !rings.slice(1).some(r => p.inRing(point, r));
      }
      return rings.some(r => p.inPolygon(point, r));
    };
    p.say = text => { p.ui.querySelector('.status').textContent = text; };
    p.invalidate = () => { p.route = null; p.walk = null; p.interactionTravel = null; p.backtrackingInfo = ''; p.backtrackingEnabled = false; p.preview.clearLayers(); if (p.ui) p.ui.querySelector('.legend')?.replaceChildren(); };
    p.scan = () => {
      if (!window.plugin.drawTools?.drawnItems) throw Error('Enable Draw Tools and reload IITC.');
      const areas = [];
      window.plugin.drawTools.drawnItems.eachLayer(layer => {
        if (layer instanceof L.Circle || layer instanceof L.Polygon) areas.push(layer);
      });
      if (!areas.length) throw Error('Draw a polygon, rectangle or circle first. Lines and markers are not areas.');
      const contains = ll => areas.some(layer => layer instanceof L.Circle
        ? p.distance(ll, layer.getLatLng()) <= layer.getRadius() + 0.001
        : p.inPolygon(ll, layer.getLatLngs()));
      for (const [id, portal] of p.pool) if (!contains(portal)) p.pool.delete(id);
      let unnamed = 0;
      for (const [guid, marker] of Object.entries(window.portals || {})) {
        const ll = marker.getLatLng();
        if (!contains(ll)) continue;
        const d = marker.options.data || {};
        if (!d.title) { unnamed++; continue; }
        p.pool.set(guid, {guid, title: d.title, imageUrl: d.image || '', lat: ll.lat, lng: ll.lng});
      }
      p.invalidate(); p.renderPortals();
      p.say(`${p.pool.size} named portals collected. ${unnamed} loaded placeholders skipped. Pan/zoom and scan again to collect more. Coverage is not guaranteed.`);
    };
    p.renderPortals = () => {
      const list = p.ui.querySelector('.portals');
      const start = p.ui.querySelector('.start');
      const end = p.ui.querySelector('.end'), oldEnd = end.value;
      const oldStart = start.value;
      list.replaceChildren(); start.replaceChildren(new Option('Automatic', '')); end.replaceChildren(new Option('Automatic', ''));
      for (const portal of p.pool.values()) {
        const label = document.createElement('label'); label.style.display = 'block';
        const box = document.createElement('input'); box.type = 'checkbox';
        box.checked = !p.excluded.has(portal.guid);
        box.onchange = () => {
          if (box.checked) p.excluded.delete(portal.guid); else p.excluded.add(portal.guid);
          p.syncBannerCount(); p.invalidate(); p.say('Selection changed. Optimize again before exporting.');
        };
        label.append(box, document.createTextNode(' ' + portal.title)); list.append(label);
        start.add(new Option(portal.title, portal.guid)); end.add(new Option(portal.title, portal.guid));
      }
      if (p.pool.has(oldStart)) start.value = oldStart;
      if (p.pool.has(oldEnd)) end.value = oldEnd;
      p.syncBannerCount();
    };
    p.checkCancel = () => { if (p.controller?.signal.aborted) throw Error('Calculation cancelled.'); };
    p.pause = async ms => { await new Promise(resolve => setTimeout(resolve, ms)); p.checkCancel(); };
    p.request = async (endpoint, body, key) => {
      p.checkCancel();
      // Conservative spacing across both endpoints, including repeated runs.
      await p.pause(Math.max(0, 3100 - (Date.now() - (p.lastRequest || 0))));
      p.lastRequest = Date.now();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      p.controller?.signal.addEventListener('abort', cancel, {once: true});
      const timer = setTimeout(cancel, 60000);
      try {
        const response = await fetch('https://api.heigit.org/openrouteservice/v2/' + endpoint, {
          method: 'POST', headers: {'Content-Type': 'application/json', Authorization: key},
          body: JSON.stringify(body), signal: controller.signal, credentials: 'omit'
        });
        if (!response.ok) {
          if (response.status === 403) {
            let data;
            try { data = await response.json(); } catch (e) {
              // A missing/non-JSON error body must not hide the HTTP status.
              if (controller.signal.aborted) throw e;
            }
            const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
            const message = typeof detail === 'string' ? detail.trim() : '';
            throw Error('Walking service access denied (403). Check your API key and account access to this API.' +
              (message ? ` Service message: ${message}` : ''));
          }
          const errors = {401: 'Invalid API key.',
            429: 'Routing quota or rate limit reached. Wait and try again.',
            400: 'Routing service rejected these portals. Try a smaller area or exclude off-path portals.',
            404: 'No walking route found for these portals.'};
          throw Error(errors[response.status] || `Walking service error (${response.status}). Try again later.`);
        }
        return await response.json();
      } catch (e) {
        p.checkCancel();
        if (e.name === 'AbortError') throw Error('Walking request timed out. Try again.');
        if (e instanceof TypeError) throw Error('Cannot reach the walking service. Check your connection and browser cross-origin restrictions.');
        throw e;
      } finally {
        clearTimeout(timer); p.controller?.signal.removeEventListener('abort', cancel);
      }
    };
    p.walkMatrix = async (points, key, progress) => {
      if (!key) throw Error('Enter an openrouteservice API key for pedestrian routing.');
      if (points.length > 300) throw Error('Pedestrian mode currently supports up to 300 selected portals.');
      const signature = JSON.stringify(points.map(v => [v.guid, v.lng, v.lat]));
      if (p.walkCache?.signature === signature) return p.walkCache.matrix;
      const n = points.length;
      if (p.matrixProgressCache?.signature !== signature) p.matrixProgressCache = {
        signature, matrix: Array.from({length: n}, () => new Float64Array(n)), completed: new Set()
      };
      const partial = p.matrixProgressCache, matrix = partial.matrix;
      const blocks = Math.ceil(n / 50); let completed = 0;
      for (let a = 0; a < n; a += 50) for (let b = 0; b < n; b += 50) {
        p.checkCancel();
        const block = a + ':' + b;
        if (partial.completed.has(block)) { completed++; continue; }
        const sources = points.slice(a, a + 50), destinations = points.slice(b, b + 50);
        const locations = sources.concat(destinations).map(v => [v.lng, v.lat]);
        progress(`Fetching walking distances ${++completed}/${blocks * blocks}…`);
        const data = await p.request('matrix/foot-walking', {locations,
          sources: sources.map((_, i) => String(i)),
          destinations: destinations.map((_, i) => String(sources.length + i)),
          metrics: ['distance'], units: 'm'}, key);
        for (const [items, snapped] of [[sources, data.sources], [destinations, data.destinations]]) {
          if (!Array.isArray(snapped) || snapped.length !== items.length) throw Error('Walking service omitted portal snapping information.');
          items.forEach((portal, i) => {
            const loc = snapped[i]?.location;
            if (!Array.isArray(loc) || !Number.isFinite(loc[0]) || !Number.isFinite(loc[1]) ||
                p.distance(portal, {lng: loc[0], lat: loc[1]}) > 30)
              throw Error(`No mapped walking path within 30m of: ${portal.title}. Exclude this portal or review its location.`);
          });
        }
        if (!Array.isArray(data.distances) || data.distances.length !== sources.length) throw Error('Invalid walking distance response.');
        for (let i = 0; i < sources.length; i++) for (let j = 0; j < destinations.length; j++) {
          const value = data.distances[i]?.[j];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw Error(`No walking connection: ${sources[i].title} → ${destinations[j].title}. Exclude disconnected portals and retry.`);
          matrix[a + i][b + j] = value;
        }
        partial.completed.add(block);
      }
      p.walkCache = {signature, matrix}; p.matrixProgressCache = null; return matrix;
    };
    p.walkGeometry = async (route, key, progress) => {
      const legs = [];
      // Overlapping chunks preserve the link between missions and API batches.
      for (let offset = 0; offset < route.length - 1; offset += 49) {
        const chunk = route.slice(offset, offset + 50);
        progress(`Fetching walking path ${offset + 1}–${offset + chunk.length}…`);
        const data = await p.request('directions/foot-walking/geojson', {
          coordinates: chunk.map(v => [v.lng, v.lat]), preference: 'recommended',
          radiuses: chunk.map(() => 30), instructions: true, units: 'm'
        }, key);
        const feature = data.features?.[0], coordinates = feature?.geometry?.coordinates;
        const segments = feature?.properties?.segments, waypoints = feature?.properties?.way_points;
        if (feature?.geometry?.type !== 'LineString' || !Array.isArray(coordinates) ||
            !Array.isArray(segments) || segments.length !== chunk.length - 1 ||
            !Array.isArray(waypoints) || waypoints.length !== chunk.length)
          throw Error('Walking service returned incomplete route geometry. Export blocked; retry.');
        segments.forEach((segment, i) => {
          const start = waypoints[i], end = waypoints[i + 1];
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= coordinates.length ||
              !Number.isFinite(segment.distance) || segment.distance < 0 || !Number.isFinite(segment.duration) || segment.duration < 0)
            throw Error('Walking service returned an invalid route segment.');
          const line = coordinates.slice(start, end + 1).map(c => {
            if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) throw Error('Invalid walking coordinates.');
            return [c[1], c[0]];
          });
          for (const [portal, ll] of [[chunk[i], line[0]], [chunk[i + 1], line[line.length - 1]]])
            if (p.distance(portal, {lat: ll[0], lng: ll[1]}) > 30.001) throw Error(`Walking path ends too far from ${portal.title}.`);
          legs.push({line, distance: segment.distance, duration: segment.duration});
        });
      }
      const geometry = {legs, distance: legs.reduce((s, v) => s + v.distance, 0), duration: legs.reduce((s, v) => s + v.duration, 0)};
      return p.useInteractionRange ? p.rangeWalk(geometry, route, progress) : geometry;
    };
    // Held–Karp gives the exact open-path ordering under the input matrix.
    p.exact = async (matrix, fixed, closed = false, fixedEnd = -1) => {
      if (closed && fixed < 0) fixed = 0;
      const n = matrix.length, states = 1 << n;
      const costs = new Float64Array(states * n).fill(Infinity);
      const parents = new Int16Array(states * n).fill(-1);
      for (let i = 0; i < n; i++) if (fixed < 0 || i === fixed) costs[(1 << i) * n + i] = 0;
      for (let mask = 1; mask < states; mask++) {
        if (mask % 1024 === 0) await p.pause(0);
        for (let last = 0; last < n; last++) {
          const cost = costs[mask * n + last]; if (!Number.isFinite(cost)) continue;
          for (let next = 0; next < n; next++) if (!(mask & (1 << next))) {
            const at = (mask | (1 << next)) * n + next, candidate = cost + matrix[last][next];
            if (candidate < costs[at]) { costs[at] = candidate; parents[at] = last; }
          }
        }
      }
      let mask = states - 1, last = 0;
      const finishCost = i => fixedEnd >= 0 && i !== fixedEnd ? Infinity : costs[mask * n + i] + (closed ? matrix[i][fixed] : 0);
      for (let i = 1; i < n; i++) if (finishCost(i) < finishCost(last)) last = i;
      const result = [];
      while (last >= 0) { result.push(last); const previous = parents[mask * n + last]; mask ^= 1 << last; last = previous; }
      return result.reverse();
    };
    p.optimize = async (points, fixedGuid, progress = () => {}, suppliedMatrix = null, closed = false, endGuid = '') => {
      const n = points.length;
      if (n > 600) throw Error('Limit this prototype to 600 selected portals.');
      const fixed = points.findIndex(v => v.guid === fixedGuid);
      if (fixedGuid && fixed < 0) throw Error('The selected start portal is excluded.');
      const fixedEnd = points.findIndex(v => v.guid === endGuid);
      if (endGuid && fixedEnd < 0) throw Error('The selected end portal is excluded.');
      if (closed && endGuid) throw Error('Return-to-start determines the ending portal automatically.');
      if (fixed >= 0 && fixed === fixedEnd && n > 1) throw Error('Choose different start and end portals, or enable return-to-start.');
      if (n < 2) return points.slice();
      const matrix = suppliedMatrix || points.map(a => points.map(b => p.distance(a, b)));
      if (matrix.length !== n || matrix.some(row => row.length !== n || Array.from(row).some(v => !Number.isFinite(v) || v < 0)))
        throw Error('Invalid route distance matrix.');
      if (n <= 16) {
        progress('Calculating exact visit order…');
        return (await p.exact(matrix, fixed, closed, fixedEnd)).map(i => points[i]);
      }
      const length = route => route.slice(1).reduce((sum, v, i) => sum + matrix[route[i]][v], 0) + (closed ? matrix[route[route.length - 1]][route[0]] : 0);
      const seeds = fixed >= 0 ? [fixed] : Array.from({length: Math.min(n, 16)}, (_, i) => Math.floor(i * n / Math.min(n, 16))).filter(i => i !== fixedEnd);
      let best, bestLength = Infinity;
      for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
        const route = [seeds[seedIndex]], used = new Set(route);
        while (route.length < n) {
          const last = route[route.length - 1]; let next = -1;
          for (let j = 0; j < n; j++) if (!used.has(j) && (j !== fixedEnd || route.length === n - 1) && (next < 0 || matrix[last][j] < matrix[last][next])) next = j;
          route.push(next); used.add(next);
        }
        // Include reversed internal edge costs: pedestrian matrices can be asymmetric.
        for (let pass = 0; pass < 100; pass++) {
          const prefix = new Float64Array(n);
          for (let k = 1; k < n; k++) prefix[k] = prefix[k - 1] + matrix[route[k]][route[k - 1]] - matrix[route[k - 1]][route[k]];
          let improvement = -1e-6, bestI = -1, bestJ = -1;
          for (let i = fixed >= 0 || closed ? 1 : 0; i < n - 1; i++) for (let j = i + 1; j < n - (fixedEnd >= 0 ? 1 : 0); j++) {
            const a = i > 0 ? route[i - 1] : null, b = route[i], c = route[j], d = j + 1 < n ? route[j + 1] : (closed ? route[0] : null);
            const delta = (a === null ? 0 : matrix[a][c] - matrix[a][b]) +
              (d === null ? 0 : matrix[b][d] - matrix[c][d]) + prefix[j] - prefix[i];
            if (delta < improvement) { improvement = delta; bestI = i; bestJ = j; }
          }
          if (bestI < 0) break;
          route.splice(bestI, bestJ - bestI + 1, ...route.slice(bestI, bestJ + 1).reverse());
          await p.pause(0);
        }
        const distance = length(route);
        if (distance < bestLength) { best = route.slice(); bestLength = distance; }
        progress(`Improving visit order ${seedIndex + 1}/${seeds.length}…`); await p.pause(0);
      }
      return best.map(i => points[i]);
    };
    // Optimize interaction locations, leaving exported portal coordinates intact.
    // Offline mode uses coordinate descent on 30m disks for a fixed visit order.
    p.rangeStraight = (route, closed) => {
      const origin = route[0], scale = Math.max(0.01, Math.cos(origin.lat * rad));
      const project = v => ({x: (((v.lng - origin.lng + 540) % 360) - 180) * 111195 * scale, y: (v.lat - origin.lat) * 111195});
      const centers = route.map(project), spots = centers.map(v => ({...v}));
      const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      for (let pass = 0; pass < 20; pass++) {
        let changed = false;
        for (let i = 0; i < spots.length; i++) {
          const center = centers[i], prev = i ? spots[i - 1] : (closed ? spots[spots.length - 1] : null);
          const next = i + 1 < spots.length ? spots[i + 1] : (closed ? spots[0] : null);
          const candidates = [spots[i], center];
          const clamp = v => {
            const d = length(center, v), ratio = d > 29.8 ? 29.8 / d : 1;
            return {x: center.x + (v.x - center.x) * ratio, y: center.y + (v.y - center.y) * ratio};
          };
          if (prev) candidates.push(clamp(prev)); if (next) candidates.push(clamp(next));
          if (prev && next) {
            const dx = next.x - prev.x, dy = next.y - prev.y, norm = dx * dx + dy * dy;
            const t = norm ? Math.max(0, Math.min(1, ((center.x - prev.x) * dx + (center.y - prev.y) * dy) / norm)) : 0;
            candidates.push(clamp({x: prev.x + t * dx, y: prev.y + t * dy}));
          }
          for (let k = 0; k < 96; k++) candidates.push({x: center.x + 29.8 * Math.cos(k * Math.PI / 48), y: center.y + 29.8 * Math.sin(k * Math.PI / 48)});
          const score = v => (prev ? length(prev, v) : 0) + (next ? length(v, next) : 0);
          let best = spots[i], cost = score(best);
          for (const candidate of candidates) {
            const value = score(candidate);
            if (value < cost - 0.0001 || (Math.abs(value - cost) <= 0.0001 && length(candidate, center) < length(best, center))) { best = candidate; cost = value; }
          }
          if (length(best, spots[i]) > 0.0001) changed = true; spots[i] = best;
        }
        if (!changed) break;
      }
      const interactions = spots.map((v, i) => {
        const point = {lat: origin.lat + v.y / 111195, lng: origin.lng + v.x / (111195 * scale)};
        // Geodesic verification corrects projection error at high latitudes.
        const meters = p.distance(route[i], point);
        if (meters > 30) { const ratio = 29.9 / meters; point.lat = route[i].lat + (point.lat - route[i].lat) * ratio; point.lng = route[i].lng + (((point.lng - route[i].lng + 540) % 360) - 180) * ratio; }
        return point;
      });
      const distance = interactions.slice(1).reduce((sum, v, i) => sum + p.distance(interactions[i], v), 0) +
        (closed ? p.distance(interactions[interactions.length - 1], interactions[0]) : 0);
      return {interactions, distance};
    };
    // Build a directed graph of already fetched walking paths, then find a
    // shortest walk through portal interaction disks in the chosen order.
    // No invented cross-country links: only traversed service edges are used.
    p.rangeWalk = async (geometry, route, progress) => {
      const nodes = [], edges = [], ids = new Map();
      const node = ll => {
        const key = ll.map(v => v.toFixed(7)).join(',');
        if (!ids.has(key)) { if (nodes.length >= 50000) throw Error('Walking path is too large for 30m interaction optimization. Select a smaller area.'); ids.set(key, nodes.length); nodes.push({lat: ll[0], lng: ll[1]}); edges.push(new Map()); }
        return ids.get(key);
      };
      for (const leg of geometry.legs) {
        for (const ll of leg.line) node(ll);
        await p.pause(0);
        let geoLength = 0;
        for (let i = 1; i < leg.line.length; i++) geoLength += p.distance({lat: leg.line[i - 1][0], lng: leg.line[i - 1][1]}, {lat: leg.line[i][0], lng: leg.line[i][1]});
        for (let i = 1; i < leg.line.length; i++) {
          const a = leg.line[i - 1], b = leg.line[i], d = p.distance({lat: a[0], lng: a[1]}, {lat: b[0], lng: b[1]});
          const steps = Math.max(1, Math.ceil(d / 10)); let from = node(a);
          for (let k = 1; k <= steps; k++) {
            const t = k / steps, ll = [a[0] + (b[0] - a[0]) * t, a[1] + ((((b[1] - a[1]) + 540) % 360) - 180) * t];
            const to = node(ll), meters = p.distance(nodes[from], nodes[to]);
            if (from !== to) {
              const old = edges[from].get(to), edge = {distance: meters, duration: geoLength ? leg.duration * meters / geoLength : 0};
              if (!old || edge.distance < old.distance) edges[from].set(to, edge);
            }
            from = to;
          }
        }
      }
      if (nodes.length > 50000) throw Error('Walking path is too large for 30m interaction optimization. Select a smaller area.');
      const candidates = [];
      for (const portal of route) {
        const values = [];
        nodes.forEach((v, i) => { const d = p.distance(portal, v); if (d <= 30) values.push({id: i, offset: d}); });
        if (!values.length) throw Error(`No verified walking position within 30m of ${portal.title}.`);
        candidates.push(values);
        if (candidates.length % 8 === 0) await p.pause(0);
      }
      const closed = route.length > 1 && route[0].guid === route[route.length - 1].guid;
      // Try up to eight start positions for loops; an open route can start
      // at any sampled position in the first portal's disk.
      const starts = closed ? candidates[0].slice().sort((a, b) => a.offset - b.offset).filter((_, i, all) =>
        i === 0 || i % Math.max(1, Math.floor(all.length / 7)) === 0).slice(0, 8) : [null];
      let winner = null;
      const failedStages = new Set();
      for (let trial = 0; trial < starts.length; trial++) {
        let active = new Map((starts[trial] ? [starts[trial]] : candidates[0]).map(v => [v.id, {distance: 0, offset: v.offset}]));
        const parents = []; let failed = false;
        for (let stage = 1; stage < candidates.length; stage++) {
          p.checkCancel();
          const distances = new Float64Array(nodes.length).fill(Infinity), offsets = new Float64Array(nodes.length).fill(Infinity);
          const previous = new Int32Array(nodes.length).fill(-1), heap = [];
          const push = value => { heap.push(value); let i = heap.length - 1; while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent][0] <= value[0]) break; heap[i] = heap[parent]; i = parent; } heap[i] = value; };
          const pop = () => { const value = heap[0], last = heap.pop(); if (heap.length) { let i = 0; while (2 * i + 1 < heap.length) { let child = 2 * i + 1; if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++; if (heap[child][0] >= last[0]) break; heap[i] = heap[child]; i = child; } heap[i] = last; } return value; };
          for (const [id, value] of active) { distances[id] = value.distance; offsets[id] = value.offset; push([value.distance, id, value.offset]); }
          let processed = 0;
          while (heap.length) {
            if (++processed % 4096 === 0) await p.pause(0);
            const [cost, id, offset] = pop(); if (cost > distances[id] + 1e-7 || offset !== offsets[id]) continue;
            for (const [next, edge] of edges[id]) {
              const value = cost + edge.distance;
              if (value < distances[next] - 1e-7 || (Math.abs(value - distances[next]) <= 1e-7 && offset < offsets[next])) {
                distances[next] = value; offsets[next] = offset; previous[next] = id; push([value, next, offset]);
              }
            }
          }
          parents.push(previous); active = new Map();
          const targets = closed && stage === candidates.length - 1 ? [starts[trial]] : candidates[stage];
          for (const target of targets) if (Number.isFinite(distances[target.id])) active.set(target.id, {distance: distances[target.id], offset: offsets[target.id] + target.offset});
          if (!active.size) { failedStages.add(stage); failed = true; break; }
          progress(`Applying 30m interaction range ${stage}/${candidates.length - 1}${closed ? ' (loop ' + (trial + 1) + '/' + starts.length + ')' : ''}…`); await p.pause(0);
        }
        if (failed) continue;
        const [end, total] = [...active].sort((a, b) => a[1].distance - b[1].distance || a[1].offset - b[1].offset)[0];
        if (winner && (total.distance > winner.distance + 1e-7 || (Math.abs(total.distance - winner.distance) <= 1e-7 && total.offset >= winner.offset))) continue;
        let cursor = end; const legs = [], interactions = [nodes[end]];
        for (let stage = parents.length - 1; stage >= 0; stage--) {
          const path = [cursor], pred = parents[stage];
          while (pred[cursor] >= 0) { cursor = pred[cursor]; path.push(cursor); }
          path.reverse(); interactions.unshift(nodes[cursor]);
          let distance = 0, duration = 0;
          for (let i = 1; i < path.length; i++) { const edge = edges[path[i - 1]].get(path[i]); distance += edge.distance; duration += edge.duration; }
          legs.unshift({line: path.map(id => [nodes[id].lat, nodes[id].lng]), distance, duration});
        }
        winner = {legs, interactions, distance: total.distance, offset: total.offset, duration: legs.reduce((sum, v) => sum + v.duration, 0)};
      }
      if (!winner) {
        p.checkCancel();
        const stages = [...failedStages].sort((a, b) => a - b);
        const details = stages.slice(0, 5).map(stage => `${route[stage - 1].title} → ${route[stage].title}`).join('; ');
        const warning = `30m interaction optimization could not connect ${stages.length} attempted transition${stages.length === 1 ? '' : 's'}${details ? ': ' + details : ''}${stages.length > 5 ? '; …' : ''}. Kept the available mapped walking legs. Review these connections; a closer approach or manual adjustment may be needed.`;
        // Preserve the service's original legs and totals. Do not invent links
        // between disconnected graph components or discard the whole route.
        return {...geometry, interactionFallback: true,
          warnings: [...new Set([...(geometry.warnings || []), warning])]};
      }
      return winner;
    };
    // Count repeated mapped edges (coordinates rounded to ~0.1m).
    // This detects retracing, not crossings; differently segmented geometry
    // and parallel paths may prevent matches. No global optimality claim.
    p.retracing = geometry => {
      const seen = new Map(); let repeated = 0, reversed = 0;
      const vertex = ll => ll.map(v => Number(v).toFixed(6)).join(',');
      for (const leg of geometry.legs) for (let i = 1; i < leg.line.length; i++) {
        const a = leg.line[i - 1], b = leg.line[i], ak = vertex(a), bk = vertex(b);
        if (ak === bk) continue;
        const forward = ak < bk, key = forward ? ak + '|' + bk : bk + '|' + ak;
        const meters = p.distance({lat: a[0], lng: a[1]}, {lat: b[0], lng: b[1]});
        if (seen.has(key)) {
          repeated += meters;
          if (seen.get(key) !== forward) reversed += meters;
        }
        seen.set(key, forward);
      }
      return {repeated, reversed, score: geometry.distance + 2 * repeated + 2 * reversed};
    };
    p.turnPenalty = (route, closed) => {
      let penalty = 0;
      for (let i = closed ? 0 : 1; i < (closed ? route.length : route.length - 1); i++) {
        const a = route[(i + route.length - 1) % route.length], b = route[i], c = route[(i + 1) % route.length];
        const longitude = d => ((d + 540) % 360) - 180;
        const x1 = longitude(b.lng - a.lng) * Math.cos(b.lat * rad), y1 = b.lat - a.lat;
        const x2 = longitude(c.lng - b.lng) * Math.cos(b.lat * rad), y2 = c.lat - b.lat;
        const norm = Math.hypot(x1, y1) * Math.hypot(x2, y2);
        if (!norm) continue;
        const cosine = Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2) / norm));
        if (cosine < 0) penalty += Math.min(p.distance(a, b), p.distance(b, c)) * -cosine;
      }
      return penalty;
    };
    // Visit selected portals on first entering their 30m interaction area.
    // Keep the actual walked trace: crossing a straight preview link is not
    // evidence of access. Sampling stays on service edges and includes joins.
    p.firstEncounterWalk = async (route, geometry, closed, endGuid, progress) => {
      p.checkCancel();
      const pending = new Map(route.slice(1).map(portal => [portal.guid, portal]));
      const end = endGuid ? pending.get(endGuid) : null;
      if (end) pending.delete(endGuid);
      const first = geometry.legs[0]?.line[0];
      if (!first || p.distance(route[0], {lat: first[0], lng: first[1]}) > 30.001)
        throw Error('Walking path does not start within reach of the starting portal.');
      const ordered = [route[0]], legs = [], interactions = [{lat: first[0], lng: first[1]}];
      let line = [first], distance = 0, duration = 0, samples = 0;
      const visit = (portal, ll) => {
        ordered.push(portal); interactions.push({lat: ll[0], lng: ll[1]});
        legs.push({line, distance, duration});
        line = [ll]; distance = 0; duration = 0;
        pending.delete(portal.guid);
      };
      const encounter = ll => {
        const point = {lat: ll[0], lng: ll[1]};
        // Preserve prior order when several portals can be visited at one spot.
        for (const portal of pending.values()) if (p.distance(portal, point) <= 30) visit(portal, ll);
      };
      encounter(first);
      trace: for (const leg of geometry.legs) {
        const lengths = leg.line.slice(1).map((ll, i) => p.distance(
          {lat: leg.line[i][0], lng: leg.line[i][1]}, {lat: ll[0], lng: ll[1]}));
        const total = lengths.reduce((sum, value) => sum + value, 0);
        for (let i = 1; i < leg.line.length; i++) {
          if (!pending.size && !end && !closed) break trace;
          const a = leg.line[i - 1], b = leg.line[i], steps = Math.max(1, Math.ceil(lengths[i - 1] / 5));
          for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            const ll = step === steps ? b : [a[0] + (b[0] - a[0]) * t,
              a[1] + (((b[1] - a[1] + 540) % 360) - 180) * t];
            const fraction = total ? lengths[i - 1] / total / steps : 1 / (leg.line.length - 1) / steps;
            line.push(ll); distance += leg.distance * fraction; duration += leg.duration * fraction;
            encounter(ll);
            if (++samples % 1024 === 0) { progress('Checking portals along the walking path…'); await p.pause(0); }
            if (!pending.size && !end && !closed) break trace;
          }
        }
      }
      if (pending.size) throw Error('Walking path does not reach every selected portal. Optimize again.');
      if (end || closed) {
        const portal = closed ? route[0] : end, last = line[line.length - 1];
        if (p.distance(portal, {lat: last[0], lng: last[1]}) > 30.001)
          throw Error('Walking path does not reach the required finish.');
        visit(portal, last);
      }
      p.checkCancel();
      return {route: closed ? ordered.slice(0, -1) : ordered, geometry: {legs, interactions,
        distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
        duration: legs.reduce((sum, leg) => sum + leg.duration, 0)}};
    };
    p.visitAsYouPass = async (route, geometry, closed, endGuid, progress) => {
      // First-encounter ordering requires a continuous trace. Retain a usable
      // service route when interaction optimization had to fall back.
      if (geometry.interactionFallback) return {route, geometry,
        info: 'Visit-as-you-pass skipped because the walking legs could not be joined within the interaction areas.'};
      const original = geometry.distance;
      let best = await p.firstEncounterWalk(route, geometry, closed, endGuid, progress);
      // Reuse only fetched directed walking edges to remove now-unnecessary
      // returns. Recheck first encounters after shortcuts change the trace.
      for (let pass = 0; pass < 3; pass++) {
        progress(`Shortening returns after early portal visits ${pass + 1}/3…`);
        const walked = closed ? best.route.concat([best.route[0]]) : best.route;
        const shortened = await p.rangeWalk(best.geometry, walked, progress);
        if (shortened.interactionFallback) {
          best.geometry = shortened;
          break;
        }
        const candidate = await p.firstEncounterWalk(best.route, shortened, closed, endGuid, progress);
        if (candidate.geometry.distance > best.geometry.distance + 0.001) break;
        const improvement = best.geometry.distance - candidate.geometry.distance;
        const sameOrder = candidate.route.every((portal, i) => portal.guid === best.route[i].guid);
        best = candidate;
        if (sameOrder && improvement < 0.1) break;
        await p.pause(0);
      }
      return {...best, info: `Visit-as-you-pass applied; ${Math.max(0, Math.round(original - best.geometry.distance))}m of walking removed. Chosen endpoints are preserved; first encounters are sampled every 5m or less.`};
    };
    p.backtrackCandidates = (route, fixed, closed, matrix, points, limit = 6, endGuid = '') => {
      const index = new Map(points.map((v, i) => [v.guid, i]));
      const distance = (a, b) => matrix ? matrix[index.get(a.guid)][index.get(b.guid)] : p.distance(a, b);
      const score = r => r.slice(1).reduce((sum, v, i) => sum + distance(r[i], v), 0) +
        (closed ? distance(r[r.length - 1], r[0]) : 0) + 2 * p.turnPenalty(r, closed);
      const baseline = score(route), candidates = [], signatures = new Set([route.map(v => v.guid).join('|')]);
      const first = fixed || closed ? 1 : 0, n = route.length;
      // Bound local search for large portal sets; fixed starts never move.
      const positions = [...new Set(Array.from({length: Math.min(n - first, 40)}, (_, i) =>
        first + Math.floor(i * (n - first) / Math.min(n - first, 40))))];
      const consider = r => {
        if (endGuid && r[r.length - 1].guid !== endGuid) return;
        const signature = r.map(v => v.guid).join('|');
        if (signatures.has(signature)) return; signatures.add(signature);
        const value = score(r);
        candidates.push({route: r, score: value}); candidates.sort((a, b) => a.score - b.score);
        if (candidates.length > limit) candidates.pop();
      };
      for (const i of positions) for (const j of positions) if (i < j) {
        consider(route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1)));
        const moved = route.slice(), portal = moved.splice(i, 1)[0]; moved.splice(j, 0, portal); consider(moved);
        const earlier = route.slice(), laterPortal = earlier.splice(j, 1)[0]; earlier.splice(i, 0, laterPortal); consider(earlier);
      }
      return {baseline, candidates};
    };
    p.reduceBacktracking = async (route, fixed, closed, matrix, points, geometry, key, progress, endGuid = '') => {
      if (!geometry) {
        let best = route;
        for (let pass = 0; pass < 8; pass++) {
          const search = p.backtrackCandidates(best, fixed, closed, matrix, points, 1, endGuid);
          if (!search.candidates.length || search.candidates[0].score >= search.baseline - 1e-6) break;
          best = search.candidates[0].route;
          progress(`Reducing sharp reversals ${pass + 1}/8…`); await p.pause(0);
        }
        return {route: best, geometry: null, info: 'Sharp-reversal preference applied (straight-line estimate).'};
      }
      const original = p.retracing(geometry);
      let best = {route, geometry, score: original.score, repeated: original.repeated};
      // Geometry is fetched only for a small shortlist, rather than every pair.
      // Even if no better candidate is found, preserve the original route.
      if (original.repeated > 1) {
        const search = p.backtrackCandidates(route, fixed, closed, matrix, points, 5, endGuid);
        for (let i = 0; i < search.candidates.length; i++) {
          const candidate = search.candidates[i].route;
          progress(`Checking backtracking alternative ${i + 1}/${search.candidates.length}…`);
          const walked = closed ? candidate.concat([candidate[0]]) : candidate;
          const alternative = await p.walkGeometry(walked, key, message => progress(`Alternative ${i + 1}: ${message}`));
          const stats = p.retracing(alternative);
          if (alternative.distance <= geometry.distance * 1.2 + 0.1 && stats.score < best.score - 1e-6 && stats.repeated <= best.repeated + 0.1)
            best = {route: candidate, geometry: alternative, score: stats.score, repeated: stats.repeated};
          await p.pause(0);
        }
      }
      return {route: best.route, geometry: best.geometry,
        info: `Matched retraced paths: ${Math.round(original.repeated)}m → ${Math.round(best.repeated)}m. Backtracking search is approximate.`};
    };
    p.maxBannerLength = (portalCount, sharedEndpoints = false) => {
      // Shared boundaries reuse one portal: M missions need 5M + 1
      // unique portals instead of 6M. A closing revisit adds no capacity.
      const capacity = sharedEndpoints ? Math.floor((portalCount - 1) / 5) : Math.floor(portalCount / 6);
      return Math.max(0, Math.floor(capacity / 6) * 6);
    };
    p.syncBannerCount = (required = false) => {
      const ui = p.ui, input = ui.querySelector('.count');
      const automatic = ui.querySelector('.maximize-banner').checked;
      const hint = ui.querySelector('.banner-hint');
      input.disabled = p.busy || automatic;
      hint.hidden = !automatic;
      if (!automatic) return Number(input.value);
      const selected = [...p.pool.keys()].filter(guid => !p.excluded.has(guid)).length;
      const shared = ui.querySelector('.shared').checked;
      const count = p.maxBannerLength(selected, shared);
      input.value = count ? String(count) : '';
      hint.textContent = count
        ? `${count} missions (${count / 6} rows of 6) from ${selected} selected portals, with at least 6 distinct portals per mission.`
        : `A 6-mission banner needs at least ${shared ? 31 : 36} selected portals${shared ? ' with shared endpoints' : ''}; currently ${selected}. Scan more portals, adjust the selection, or turn off maximization.`;
      if (required && !count) throw Error(hint.textContent);
      return count;
    };
    p.split = (route, count, sharedEndpoints = false, closed = false) => {
      const slots = route.length + (sharedEndpoints ? count - 1 : 0);
      if (!Number.isInteger(count) || count < 1 || slots < 6 * count)
        throw Error('Choose a mission count that leaves at least 6 portals in every mission.');
      let offset = 0;
      const chunks = Array.from({length: count}, (_, i) => {
        const size = Math.floor(slots / count) + (i < slots % count ? 1 : 0);
        const chunk = route.slice(offset, offset + size);
        offset += size - (sharedEndpoints ? 1 : 0); return chunk;
      });
      if (closed) chunks[chunks.length - 1].push(route[0]);
      return chunks;
    };
    p.exportState = (route, count, name, description, sharedEndpoints = false, closed = false) => ({
      missionSetName: name, missionSetDescription: description, currentMission: 0,
      plannedBannerLength: count, titleFormat: 'T NN-M', fileFormatVersion: 2,
      missions: p.split(route, count, sharedEndpoints, closed).map((chunk, i) => ({
        missionTitle: `${name} ${String(i + 1).padStart(String(count).length, '0')}-${count}`,
        missionDescription: description,
        portals: chunk.map(v => ({description: '', guid: v.guid, imageUrl: v.imageUrl,
          isOrnamented: false, isStartPoint: false,
          location: {latitude: v.lat, longitude: v.lng}, title: v.title, type: 'PORTAL',
          objective: {type: 'HACK_PORTAL', passphrase_params: {question: '', _single_passphrase: ''}}}))
      }))
    });
    p.draw = () => {
      p.preview.clearLayers();
      const chunks = p.split(p.route, p.syncBannerCount(true), p.ui.querySelector('.shared').checked, p.closed);
      const colors = ['#ffb347', '#54d9ff', '#e08aff', '#7fe895', '#ff8093', '#fff07a'];
      if (p.walk) {
        // Separate lines preserve any gaps in fallback geometry. Draw first
        // so mission links and portal markers remain above the walking trace.
        L.polyline(p.walk.legs.map(leg => leg.line).filter(line => line.length > 1),
          {color: '#a8adb2', weight: 3, opacity: 0.5, interactive: false}).addTo(p.preview);
      } else {
        L.polyline(p.route.map(v => [v.lat, v.lng]), {color: '#aaa', weight: 2, dashArray: '5 8', interactive: false}).addTo(p.preview);
      }
      const legend = p.ui.querySelector('.legend');
      if (legend) {
        legend.replaceChildren();
        if (p.walk) {
          const item = document.createElement('div'); item.style.color = '#a8adb2';
          item.textContent = 'Grey trace: calculated walking path'; legend.append(item);
        }
        chunks.forEach((chunk, i) => {
          const item = document.createElement('div'); item.style.color = colors[i % colors.length];
          item.textContent = `● Mission ${i + 1}: ${chunk.length} waypoints`; legend.append(item);
        });
      }
      const memberships = new Map();
      chunks.forEach((chunk, mission) => {
        chunk.forEach((portal, position) => {
          if (!memberships.has(portal.guid)) memberships.set(portal.guid, []);
          if (!memberships.get(portal.guid).includes(mission)) memberships.get(portal.guid).push(mission);
        });
        L.polyline(chunk.map(v => [v.lat, v.lng]),
          {color: colors[mission % colors.length], weight: 4, interactive: false}).addTo(p.preview);
      });
      p.route.forEach((portal, i) => {
        const missions = memberships.get(portal.guid), shared = missions.length > 1;
        const label = document.createElement('span');
        label.textContent = `${i + 1}. ${portal.title} • Mission ${missions.map(m => m + 1).join(' / ')}${shared ? ' (shared end/start)' : ''}${p.closed && i === 0 ? ' • ROUTE START / FINISH' : ''}`;
        L.circleMarker([portal.lat, portal.lng], {radius: shared ? 8 : 5,
          color: shared ? '#fff' : colors[missions[0] % colors.length], fillOpacity: 1})
          .bindTooltip(label).addTo(p.preview);
      });
      const meters = p.route.slice(1).reduce((sum, v, i) => sum + p.distance(p.route[i], v), 0) + (p.closed ? p.distance(p.route[p.route.length - 1], p.route[0]) : 0);
      p.say(`${p.route.length} unique portals • ${chunks.length} missions (${chunks.map(c => c.length).join(', ')} portals) • ${p.walk ? (p.walk.distance / 1000).toFixed(2) + ' km walking • ~' + Math.round(p.walk.duration / 60) + ' min moving time' : ((p.interactionTravel?.distance ?? meters) / 1000).toFixed(2) + ' km within interaction range'} including mission transitions${p.closed ? ' and return to start' : ''}. ${p.ui.querySelector('.shared').checked ? 'Shared mission endpoints enabled.' : ''} 30m interaction range. ${p.backtrackingEnabled ? p.backtrackingInfo : 'Approximate visit order.'} ${p.walk ? 'Grey trace shows the calculated walking path; colored links show portal visit order.' : ''} Ready to export.${p.walk?.warnings?.length ? ' Warning: ' + p.walk.warnings.join(' ') : ''}`);
      p.preview.addTo(window.map);
    };
    p.open = () => {
      if (p.ui) { window.dialog({id: 'mission-router', title: 'Mission Route Planner v0.10.0', html: p.ui, width: 440}); return; }
      const ui = p.ui = document.createElement('div');
      ui.innerHTML = `<p><strong>Mission Route Planner v0.10.0</strong></p><p>Draw areas, then scan loaded portals. Multiple areas are combined. Scan again after panning to collect more portals.</p>
        <button class="scan">Scan drawn areas</button> <button class="clear">Clear collection</button>
        <div class="portals" style="max-height:180px;overflow:auto;margin:10px 0"></div>
        <label>Routing <select class="mode"><option value="straight">Straight-line estimate (offline)</option><option value="walk">Pedestrian paths (optional)</option></select></label>
        <div class="walking-settings" hidden><label>openrouteservice API key <input class="key" type="password" autocomplete="off" style="width:100%"></label>
        <p><a href="https://account.heigit.org/" target="_blank" rel="noopener noreferrer">Get an API key</a>. Kept only until reload. Pedestrian calculation sends selected coordinates to openrouteservice. Maximum 300 portals. Large selections take longer and use more routing requests. If interrupted, Optimize reuses completed distance batches for the same selection until reload. Paths must be within 30m of portals. <a href="https://openrouteservice.org/" target="_blank" rel="noopener noreferrer">© openrouteservice</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>.</p>
        <label style="display:block;margin-top:8px"><input class="visit-passing" type="checkbox" checked> Visit portals as you pass them</label>
        <p>Visit selected portals when the walking path first comes within 30m. Keep the chosen start and finish, and shorten later returns where possible. Uses fetched paths without extra API requests. Nearby portals may share an interaction spot; review physical access on the map.</p></div>
        <label>Starting portal <select class="start" style="width:100%"><option value="">Automatic</option></select></label>
        <label>Ending portal <select class="end" style="width:100%"><option value="">Automatic</option></select></label>
        <p class="end-hint" hidden>Return-to-start is enabled: the route ends at its starting portal. The ending-portal selection is ignored.</p>
        <label>Mission count <input class="count" type="number" min="1" step="1" value="1" style="width:60px"></label>
        <label style="display:block;margin-top:8px"><input class="maximize-banner" type="checkbox"> Maximize banner length</label>
        <p>Automatically choose 6, 12, 18… missions using all selected portals, with at least 6 distinct portals in each mission. Shared endpoints can support a longer banner; return-to-start does not add a distinct portal.</p>
        <p class="banner-hint" role="status" aria-live="polite" hidden></p>
        <label style="display:block;margin-top:8px"><input class="shared" type="checkbox"> Start each next mission at the previous mission’s last portal</label>
        <label style="display:block;margin-top:8px"><input class="closed" type="checkbox"> Start and end the entire route at the same portal</label>
        <label style="display:block;margin-top:8px"><input class="backtracking" type="checkbox"> Reduce backtracking</label>
        <p>Prefer less retracing. Pedestrian mode allows up to 20% extra distance and checks up to 5 alternatives and uses extra API requests. Straight-line mode discourages sharp reversals only.</p>
        <p>Assumes interaction within 30m of each portal. Shorter travel takes priority; equally short approaches favor being closer. Colored links and exports retain the actual portal positions; the grey walking trace shows the calculated approaches.</p>
        <p>Split all selected portals evenly, with at least 6 per mission. With the toggle on, adjacent missions share one endpoint, which counts in both missions. Return-to-start adds the starting portal as the final waypoint of the last mission. Each mission has at least 6 distinct portals before the return waypoint is added.</p>
        <label>Banner / mission name <input class="name" value="My mission" style="width:100%"></label>
        <label>Description <textarea class="description" rows="3" style="width:100%"></textarea></label>
        <button class="optimize">Optimize route</button> <button class="cancel" disabled>Cancel</button> <button class="export">Export UMM JSON</button>
        <div class="legend" style="margin-top:8px"></div><p class="status" role="status" aria-live="polite">Straight-line mode makes no external requests. Pedestrian mode shows a faint grey walking path beneath the mission-colored portal links.</p>`;
      const on = (selector, action) => { ui.querySelector(selector).onclick = async () => {
        if (p.busy) return;
        try { await action(); } catch (e) { p.say(e.message); }
      }; };
      ui.querySelector('.cancel').onclick = () => p.controller?.abort();
      ui.querySelector('.mode').onchange = () => {
        ui.querySelector('.walking-settings').hidden = ui.querySelector('.mode').value !== 'walk';
        p.invalidate(); p.say('Routing mode changed. Optimize again.');
      };
      on('.scan', p.scan);
      on('.clear', () => { p.walkCache = null; p.matrixProgressCache = null; p.pool.clear(); p.excluded.clear(); p.invalidate(); p.renderPortals(); p.say('Collection cleared.'); });
      ui.querySelector('.backtracking').onchange = () => { p.invalidate(); p.say('Backtracking preference changed. Optimize again.'); };
      ui.querySelector('.visit-passing').onchange = () => { p.invalidate(); p.say('Visit-as-you-pass preference changed. Optimize again.'); };
      ui.querySelector('.closed').onchange = () => {
        ui.querySelector('.end').disabled = ui.querySelector('.closed').checked;
        ui.querySelector('.end-hint').hidden = !ui.querySelector('.closed').checked;
        p.invalidate(); p.say('Return-to-start changed. Optimize again.');
      };
      ui.querySelector('.end').onchange = () => { p.invalidate(); p.say('End portal changed. Optimize again.'); };
      ui.querySelector('.start').onchange = () => { p.invalidate(); p.say('Start changed. Optimize again.'); };
      ui.querySelector('.shared').onchange = ui.querySelector('.count').onchange = () => {
        try { p.syncBannerCount(true); if (p.route) p.draw(); } catch (e) { p.preview.clearLayers(); p.say(e.message); }
      };
      ui.querySelector('.maximize-banner').onchange = () => {
        if (ui.querySelector('.maximize-banner').checked) p.manualMissionCount = ui.querySelector('.count').value;
        else ui.querySelector('.count').value = p.manualMissionCount || '1';
        try { p.syncBannerCount(true); if (p.route) p.draw(); } catch (e) { p.preview.clearLayers(); p.say(e.message); }
      };
      on('.optimize', async () => {
        p.invalidate();
        const points = [...p.pool.values()].filter(v => !p.excluded.has(v.guid));
        p.split(points, p.syncBannerCount(true), ui.querySelector('.shared').checked);
        p.controller = new AbortController();
        p.busy = true; ui.querySelectorAll('input,select,button,textarea').forEach(el => el.disabled = true);
        ui.querySelector('.cancel').disabled = false;
        p.say('Optimizing…');
        try {
          const key = ui.querySelector('.key').value.trim(), walking = ui.querySelector('.mode').value === 'walk';
          const fixed = ui.querySelector('.start').value;
          const endGuid = ui.querySelector('.closed').checked ? '' : ui.querySelector('.end').value;
          if (endGuid && !points.some(v => v.guid === endGuid)) throw Error('The selected end portal is excluded.');
          if (fixed && endGuid === fixed) throw Error('Choose different start and end portals, or enable return-to-start.');
          if (fixed && !points.some(v => v.guid === fixed)) throw Error('The selected start portal is excluded.');
          const rawMatrix = walking ? await p.walkMatrix(points, key, p.say) : points.map(a => points.map(b => p.distance(a, b)));
          // Pairwise disk-distance estimates guide ordering; the final path uses
          // consistent interaction positions, never these bounds as its total.
          const visitPassing = walking && ui.querySelector('.visit-passing').checked;
          // Clamping every edge below 60m to zero erases order in dense groups.
          // Start with mapped distances, then optimize actual interaction spots.
          const matrix = visitPassing ? rawMatrix : rawMatrix.map(row => Array.from(row, d => Math.max(0, d - 60)));
          p.useInteractionRange = true;
          const closed = ui.querySelector('.closed').checked;
          let route = await p.optimize(points, fixed, p.say, matrix, closed, endGuid);
          if (!walking) {
            for (let pass = 0; pass < 3; pass++) {
              const baseline = p.rangeStraight(route, closed); let bestRoute = route, bestLength = baseline.distance;
              const shortlist = p.backtrackCandidates(route, fixed, closed, matrix, points, 5, endGuid).candidates;
              for (const candidate of shortlist) {
                const travel = p.rangeStraight(candidate.route, closed);
                if (travel.distance < bestLength - 0.001) { bestRoute = candidate.route; bestLength = travel.distance; }
              }
              if (bestRoute === route) break; route = bestRoute; await p.pause(0);
            }
          }
          const walkingRoute = closed ? route.concat([route[0]]) : route;
          let geometry = walking ? await p.walkGeometry(walkingRoute, key, p.say) : null;
          const backtracking = ui.querySelector('.backtracking').checked;
          let backtrackingInfo = '';
          if (backtracking) {
            const refined = await p.reduceBacktracking(route, fixed, closed, matrix, points, geometry, key, p.say, endGuid);
            route = refined.route; geometry = refined.geometry; backtrackingInfo = refined.info;
          }
          if (visitPassing) {
            const refined = await p.visitAsYouPass(route, geometry, closed, endGuid, p.say);
            route = refined.route; geometry = refined.geometry;
            backtrackingInfo = `${backtrackingInfo} ${refined.info}`.trim();
          }
          p.checkCancel(); p.route = route; p.walk = geometry; p.interactionTravel = geometry || p.rangeStraight(route, closed); p.closed = closed; p.backtrackingEnabled = backtracking || visitPassing; p.backtrackingInfo = backtrackingInfo; p.draw();
        } catch (e) { p.invalidate(); throw e; }
        finally {
          p.busy = false; p.controller = null;
          ui.querySelectorAll('input,select,button,textarea').forEach(el => el.disabled = false);
          ui.querySelector('.cancel').disabled = true;
          ui.querySelector('.end').disabled = ui.querySelector('.closed').checked;
          p.syncBannerCount();
        }
      });
      on('.export', () => {
        if (!p.route) throw Error('Optimize the current selection first.');
        const name = ui.querySelector('.name').value.trim();
        if (!name) throw Error('Enter a banner or mission name.');
        const state = p.exportState(p.route, p.syncBannerCount(true), name, ui.querySelector('.description').value, ui.querySelector('.shared').checked, p.closed);
        const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'}));
        const link = document.createElement('a'); link.href = url;
        link.download = (name.replace(/[^a-z0-9_-]/gi, '_') || 'missions') + '-umm.json';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
        p.say('Export downloaded. Back up any existing UMM plan, then import the JSON using UMM Opt.' + (p.walk?.warnings?.length ? ' Warning: ' + p.walk.warnings.join(' ') : ''));
      });
      p.open();
    };
    function setup() {
      p.preview = L.layerGroup(); window.addLayerGroup('Mission route preview', p.preview, true);
      const link = document.createElement('a'); link.textContent = 'Mission Route Planner'; link.href = '#';
      link.onclick = e => { e.preventDefault(); p.open(); };
      document.getElementById('toolbox').append(link);
    }
    setup.info = {pluginId: 'mission-router', script: {name: 'Mission Route Planner', version: '0.10.0'}};
    if (!window.bootPlugins) window.bootPlugins = [];
    window.bootPlugins.push(setup);
    if (window.iitcLoaded) setup();
  }
  const script = document.createElement('script');
  script.textContent = '(' + wrapper.toString() + ')();';
  (document.body || document.head || document.documentElement).appendChild(script); script.remove();
})();
