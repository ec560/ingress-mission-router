// ==UserScript==
// @name         IITC plugin: Mission Route Planner
// @namespace    opayc.ingress.mission-router
// @version      0.11.4
// @description  Route loaded portals inside Draw Tools areas and export UMM 0.7.3 JSON.
// @match        https://intel.ingress.com/*
// @connect      api.heigit.org
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';
  const ORS_BASE = 'https://api.heigit.org/openrouteservice/v2/';
  const ORS_ENDPOINTS = new Set([
    'snap/foot-walking/json',
    'matrix/foot-walking',
    'directions/foot-walking/geojson'
  ]);
  const random = typeof globalThis.crypto?.getRandomValues === 'function'
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(36)).join('-')
    : Math.random().toString(36).slice(2);
  const requestEvent = `mission-router:${random}:request`;
  const responseEvent = `mission-router:${random}:response`;
  const pendingRequests = new Map();
  const promptForKey = globalThis.prompt.bind(globalThis);
  let orsKey = '';
  const readKey = () => orsKey;
  const keyState = () => ({hasKey: Boolean(readKey())});
  const reply = (id, payload) => document.dispatchEvent(new CustomEvent(responseEvent, {
    detail: JSON.stringify({id, ...payload})
  }));
  const configureKey = () => {
    const value = promptForKey('Paste your openrouteservice API key. It will be kept outside the IITC page until you reload it. Enter a blank value to remove the key.');
    if (value === null) return {changed: false, ...keyState()};
    orsKey = value.trim();
    return {changed: true, ...keyState()};
  };

  document.addEventListener(requestEvent, event => {
    let message;
    try { message = JSON.parse(event.detail); } catch (_) { return; }
    if (!message || typeof message.id !== 'string' || typeof message.action !== 'string') return;
    const {id, action} = message;
    if (action === 'cancel') {
      const request = pendingRequests.get(message.target);
      if (request) { pendingRequests.delete(message.target); request.abort(); }
      return;
    }
    if (action === 'key-status') { reply(id, {ok: true, result: keyState()}); return; }
    if (action === 'configure-key') { reply(id, {ok: true, result: configureKey()}); return; }
    if (action !== 'ors-request') { reply(id, {ok: false, error: 'unsupported', message: 'Unsupported userscript bridge action.'}); return; }

    const endpoint = message.payload?.endpoint;
    if (!ORS_ENDPOINTS.has(endpoint)) {
      reply(id, {ok: false, error: 'blocked-endpoint', message: 'Blocked an unsupported walking-service endpoint.'});
      return;
    }
    const key = readKey();
    if (!key) {
      reply(id, {ok: false, error: 'missing-key', message: 'No openrouteservice API key is saved.'});
      return;
    }
    let settled = false, timer;
    const finish = payload => {
      if (settled) return;
      settled = true; clearTimeout(timer); pendingRequests.delete(id); reply(id, payload);
    };
    try {
      const request = GM_xmlhttpRequest({
        method: 'POST', url: ORS_BASE + endpoint,
        headers: {'Content-Type': 'application/json', Authorization: key},
        data: JSON.stringify(message.payload?.body ?? {}), anonymous: true, timeout: 60000,
        onload: response => {
          const text = String(response.responseText || '').split(key).join('[redacted]');
          let body = null;
          if (text) try { body = JSON.parse(text); } catch (_) {}
          finish({ok: true, result: {status: response.status, body}});
        },
        onerror: () => finish({ok: false, error: 'network', message: 'The walking-service request failed.'}),
        ontimeout: () => finish({ok: false, error: 'timeout', message: 'The walking-service request timed out.'}),
        onabort: () => finish({ok: false, error: 'cancelled', message: 'The walking-service request was cancelled.'})
      });
      if (!settled) {
        pendingRequests.set(id, request);
        timer = setTimeout(() => {
          finish({ok: false, error: 'timeout', message: 'The walking-service request timed out.'});
          request.abort();
        }, 60000);
      }
    } catch (_) {
      finish({ok: false, error: 'network', message: 'The userscript manager could not start the walking-service request.'});
    }
  });

  function wrapper(bridge) {
    if (typeof window.plugin !== 'function') window.plugin = function () {};
    if (window.plugin.missionRouter) return;
    const p = window.plugin.missionRouter = {};
    const bridgePending = new Map();
    let bridgeSequence = 0;
    document.addEventListener(bridge.responseEvent, event => {
      let message;
      try { message = JSON.parse(event.detail); } catch (_) { return; }
      const pending = bridgePending.get(message?.id);
      if (!pending) return;
      bridgePending.delete(message.id); pending.cleanup();
      if (message.ok) pending.resolve(message.result);
      else {
        const error = Error(message.message || 'Userscript bridge request failed.');
        error.code = message.error; pending.reject(error);
      }
    });
    p.bridge = (action, payload = {}, signal) => new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${++bridgeSequence}`;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (!bridgePending.delete(id)) return;
        cleanup();
        document.dispatchEvent(new CustomEvent(bridge.requestEvent, {
          detail: JSON.stringify({id: `${id}-cancel`, action: 'cancel', target: id})
        }));
        const error = Error('Userscript bridge request cancelled.'); error.name = 'AbortError'; reject(error);
      };
      bridgePending.set(id, {resolve, reject, cleanup});
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) { abort(); return; }
      document.dispatchEvent(new CustomEvent(bridge.requestEvent, {
        detail: JSON.stringify({id, action, payload})
      }));
    });
    p.hasApiKey = Boolean(bridge.hasKey);
    p.showKeyState = hasKey => {
      p.hasApiKey = Boolean(hasKey);
      const status = p.ui?.querySelector('.key-status');
      if (status) status.textContent = p.hasApiKey
        ? 'API key set for this page session.'
        : 'No API key set.';
    };
    p.refreshKeyState = async () => {
      const state = await p.bridge('key-status'); p.showKeyState(state.hasKey); return state.hasKey;
    };
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
      p.say(`${p.pool.size} named portal${p.pool.size === 1 ? '' : 's'} ready.${unnamed ? ` ${unnamed} unnamed portal${unnamed === 1 ? '' : 's'} not included.` : ''} If any portals are missing, pan to load them and scan again.`);
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
      if (!p.pool.size) {
        const empty = document.createElement('p'); empty.className = 'mr-empty';
        empty.textContent = 'No portals collected yet.'; list.append(empty);
      }
      if (p.pool.has(oldStart)) start.value = oldStart;
      if (p.pool.has(oldEnd)) end.value = oldEnd;
      p.syncBannerCount();
    };
    p.checkCancel = () => { if (p.controller?.signal.aborted) throw Error('Calculation cancelled.'); };
    p.pause = async ms => { await new Promise(resolve => setTimeout(resolve, ms)); p.checkCancel(); };
    p.request = async (endpoint, body) => {
      p.checkCancel();
      // Conservative spacing across both endpoints, including repeated runs.
      await p.pause(Math.max(0, 3100 - (Date.now() - (p.lastRequest || 0))));
      p.lastRequest = Date.now();
      try {
        const response = await p.bridge('ors-request', {endpoint, body}, p.controller?.signal);
        if (response.status < 200 || response.status >= 300) {
          if (response.status === 403) {
            const data = response.body;
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
        return response.body;
      } catch (e) {
        p.checkCancel();
        if (e.code === 'missing-key') throw Error('Set an openrouteservice API key before using pedestrian routing.');
        if (e.code === 'timeout') throw Error('Walking request timed out. Try again.');
        if (e.code === 'network') throw Error('Cannot reach the walking service. Check your connection and userscript-manager permissions.');
        throw e;
      }
    };
    p.walkMatrix = async (points, progress) => {
      if (!await p.refreshKeyState()) throw Error('Set an openrouteservice API key before using pedestrian routing.');
      if (points.length > 300) throw Error('Pedestrian mode currently supports up to 300 selected portals.');
      const signature = JSON.stringify(points.map(v => [v.guid, v.lng, v.lat]));
      if (p.walkCache?.signature === signature) { p.walkAccess = p.walkCache.access; return p.walkCache.matrix; }
      const n = points.length;
      if (p.matrixProgressCache?.signature !== signature) p.matrixProgressCache = {
        signature, matrix: points.map(a => Float64Array.from(points, b => p.distance(a, b))),
        completed: new Set(), access: null
      };
      const partial = p.matrixProgressCache, matrix = partial.matrix;
      if (!partial.access) {
        progress('Checking for mapped walking paths within 40m of portals…');
        const data = await p.request('snap/foot-walking/json', {
          locations: points.map(v => [v.lng, v.lat]), radius: 40
        });
        if (!Array.isArray(data.locations) || data.locations.length !== n)
          throw Error('Walking service returned incomplete path proximity information.');
        const access = new Map();
        points.forEach((portal, i) => {
          const snapped = data.locations[i];
          if (snapped === null) { access.set(portal.guid, {offPath: true, distance: null}); return; }
          const loc = snapped?.location;
          if (!Array.isArray(loc) || !Number.isFinite(loc[0]) || !Number.isFinite(loc[1]))
            throw Error('Walking service returned invalid path proximity information.');
          const distance = Number.isFinite(snapped.snapped_distance) && snapped.snapped_distance >= 0
            ? snapped.snapped_distance : p.distance(portal, {lng: loc[0], lat: loc[1]});
          access.set(portal.guid, {location: loc, distance, offPath: distance >= 40});
        });
        partial.access = access;
      }
      p.walkAccess = partial.access;
      const onPath = points.map((portal, index) => ({portal, index})).filter(v => !p.walkAccess.get(v.portal.guid).offPath);
      const blocks = Math.ceil(onPath.length / 50); let completed = 0;
      // Only reachable portals go to the matrix service. All other pairs keep
      // their straight-line estimates instead of failing the complete matrix.
      for (let a = 0; a < onPath.length; a += 50) for (let b = 0; b < onPath.length; b += 50) {
        p.checkCancel();
        const block = a + ':' + b;
        if (partial.completed.has(block)) { completed++; continue; }
        const sources = onPath.slice(a, a + 50), destinations = onPath.slice(b, b + 50);
        const locations = sources.concat(destinations).map(v => p.walkAccess.get(v.portal.guid).location);
        progress(`Fetching walking distances ${++completed}/${blocks * blocks}…`);
        const data = await p.request('matrix/foot-walking', {locations,
          sources: sources.map((_, i) => String(i)),
          destinations: destinations.map((_, i) => String(sources.length + i)),
          metrics: ['distance'], units: 'm'});
        for (const [items, snapped] of [[sources, data.sources], [destinations, data.destinations]]) {
          if (!Array.isArray(snapped) || snapped.length !== items.length) throw Error('Walking service omitted portal snapping information.');
          items.forEach(({portal}, i) => {
            const loc = snapped[i]?.location;
            if (!Array.isArray(loc) || !Number.isFinite(loc[0]) || !Number.isFinite(loc[1]) ||
                p.distance({lng: p.walkAccess.get(portal.guid).location[0], lat: p.walkAccess.get(portal.guid).location[1]}, {lng: loc[0], lat: loc[1]}) > 1)
              throw Error(`Walking service could not use the checked path near ${portal.title}. Retry the calculation.`);
          });
        }
        if (!Array.isArray(data.distances) || data.distances.length !== sources.length) throw Error('Invalid walking distance response.');
        for (let i = 0; i < sources.length; i++) for (let j = 0; j < destinations.length; j++) {
          const value = data.distances[i]?.[j];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw Error(`No walking connection: ${sources[i].portal.title} → ${destinations[j].portal.title}. Exclude disconnected portals and retry.`);
          matrix[sources[i].index][destinations[j].index] = value;
        }
        partial.completed.add(block);
      }
      p.checkCancel();
      p.walkCache = {signature, matrix, access: partial.access}; p.matrixProgressCache = null; return matrix;
    };
    p.pathPosition = portal => {
      const access = p.walkAccess?.get(portal.guid);
      return access && !access.offPath ? access.location : [portal.lng, portal.lat];
    };
    p.summarizeWalk = (legs, warnings = []) => ({legs,
      distance: legs.reduce((sum, leg) => sum + leg.distance, 0),
      duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
      estimatedDistance: legs.reduce((sum, leg) => sum + (leg.estimated ? leg.distance : 0), 0),
      hasEstimates: legs.some(leg => leg.estimated), warnings: [...new Set(warnings)]});
    p.joinEstimatedLegs = (legs, closed = false) => {
      // End estimates at the actual mapped geometry, including any shift made
      // by interaction optimization. Never insert estimates into the path graph.
      return legs.map((leg, i) => {
        if (!leg.estimated) return leg;
        const previous = i > 0 ? legs[i - 1] : closed ? legs.at(-1) : null;
        const next = i + 1 < legs.length ? legs[i + 1] : closed ? legs[0] : null;
        const a = previous && !previous.estimated ? previous.line.at(-1) : leg.line[0];
        const b = next && !next.estimated ? next.line[0] : leg.line.at(-1);
        const distance = p.distance({lat: a[0], lng: a[1]}, {lat: b[0], lng: b[1]});
        return {line: [a, b], distance, duration: distance / 1.4, estimated: true};
      });
    };
    p.walkGeometry = async (route, progress) => {
      const offPath = portal => p.walkAccess?.get(portal.guid)?.offPath;
      if (!route.some(offPath)) return p.mappedWalkGeometry(route, progress);
      const legs = [], warnings = [];
      for (const portal of new Map(route.filter(offPath).map(v => [v.guid, v])).values()) {
        const distance = p.walkAccess.get(portal.guid).distance;
        warnings.push(`${portal.title}: ${distance === null ? 'no mapped walking path within 40m' : distance.toFixed(1) + 'm from the mapped walking path'}. Using straight-line estimates until the route returns to a mapped path.`);
      }
      progress(`Warning: ${warnings.join(' ')}`);
      for (let i = 0; i < route.length - 1;) {
        p.checkCancel();
        if (offPath(route[i]) || offPath(route[i + 1])) {
          const line = [p.pathPosition(route[i]), p.pathPosition(route[i + 1])].map(v => [v[1], v[0]]);
          legs.push({line, distance: 0, duration: 0, estimated: true}); i++;
        } else {
          let end = i + 1;
          while (end + 1 < route.length && !offPath(route[end + 1])) end++;
          const mapped = await p.mappedWalkGeometry(route.slice(i, end + 1), progress);
          legs.push(...mapped.legs); warnings.push(...(mapped.warnings || [])); i = end;
        }
      }
      return p.summarizeWalk(p.joinEstimatedLegs(legs, route[0].guid === route.at(-1).guid), warnings);
    };
    p.mappedWalkGeometry = async (route, progress) => {
      const legs = [];
      // Overlapping chunks preserve the link between missions and API batches.
      for (let offset = 0; offset < route.length - 1; offset += 49) {
        const chunk = route.slice(offset, offset + 50);
        progress(`Fetching walking path ${offset + 1}–${offset + chunk.length}…`);
        const data = await p.request('directions/foot-walking/geojson', {
          coordinates: chunk.map(p.pathPosition), preference: 'recommended',
          radiuses: chunk.map(() => p.walkAccess ? 1 : 40), instructions: true, units: 'm'
        });
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
            if (p.distance(portal, {lat: ll[0], lng: ll[1]}) > 40.001) throw Error(`Walking path ends too far from ${portal.title}.`);
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
      if (geometry.hasEstimates) throw Error('Straight-line estimates must be optimized separately from mapped paths.');
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
        if (!values.length) {
          p.checkCancel();
          return {...geometry, interactionFallback: true, warnings: [...(geometry.warnings || []),
            `No verified walking position within 30m of ${portal.title}. Kept mapped walking directions; review the approach from the path to this portal.`]};
        }
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
      if (geometry.hasEstimates) {
        // Refine each mapped run independently, fixing its boundary portals.
        // An estimated crossing is never evidence that a portal is accessible.
        const walked = closed ? route.concat([route[0]]) : route;
        const ordered = [walked[0]], legs = [], warnings = [...(geometry.warnings || [])];
        for (let i = 0; i < geometry.legs.length;) {
          p.checkCancel();
          if (geometry.legs[i].estimated) {
            legs.push(geometry.legs[i]); ordered.push(walked[i + 1]); i++;
          } else {
            let end = i + 1;
            while (end < geometry.legs.length && !geometry.legs[end].estimated) end++;
            const segment = walked.slice(i, end + 1), mapped = p.summarizeWalk(geometry.legs.slice(i, end));
            // Recheck interaction feasibility because a mapped run may have
            // retained its original geometry after a 30m optimization fallback.
            const ranged = await p.rangeWalk(mapped, segment, progress);
            const refined = await p.visitAsYouPass(segment, ranged, false, segment.at(-1).guid, progress);
            ordered.push(...refined.route.slice(1)); legs.push(...refined.geometry.legs);
            warnings.push(...(refined.geometry.warnings || [])); i = end;
          }
        }
        return {route: closed ? ordered.slice(0, -1) : ordered,
          geometry: p.summarizeWalk(p.joinEstimatedLegs(legs, closed), warnings),
          info: 'Visit-as-you-pass applied to mapped sections only. Straight-line sections remain estimates.'};
      }
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
      const metrics = r => {
        const travel = r.slice(1).reduce((sum, v, i) => sum + distance(r[i], v), 0) +
          (closed ? distance(r[r.length - 1], r[0]) : 0);
        const penalty = p.turnPenalty(r, closed);
        return {distance: travel, penalty, score: travel + 2 * penalty};
      };
      const baselineMetrics = metrics(route), candidates = [], signatures = new Set([route.map(v => v.guid).join('|')]);
      const first = fixed || closed ? 1 : 0, n = route.length;
      // Bound local search for large portal sets; fixed starts never move.
      const positions = [...new Set(Array.from({length: Math.min(n - first, 40)}, (_, i) =>
        first + Math.floor(i * (n - first) / Math.min(n - first, 40))))];
      const consider = r => {
        if (endGuid && r[r.length - 1].guid !== endGuid) return;
        const signature = r.map(v => v.guid).join('|');
        if (signatures.has(signature)) return; signatures.add(signature);
        candidates.push({route: r, ...metrics(r)}); candidates.sort((a, b) => a.score - b.score);
        if (candidates.length > limit) candidates.pop();
      };
      for (const i of positions) for (const j of positions) if (i < j) {
        consider(route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1)));
        const moved = route.slice(), portal = moved.splice(i, 1)[0]; moved.splice(j, 0, portal); consider(moved);
        const earlier = route.slice(), laterPortal = earlier.splice(j, 1)[0]; earlier.splice(i, 0, laterPortal); consider(earlier);
      }
      return {baseline: baselineMetrics.score, baselineDistance: baselineMetrics.distance,
        baselinePenalty: baselineMetrics.penalty, candidates};
    };
    p.reduceBacktracking = async (route, fixed, closed, matrix, points, progress, endGuid = '', pedestrian = false) => {
      // Compare portal orders from the distance matrix already in memory. The
      // selected order receives its single directions request afterward.
      let search = p.backtrackCandidates(route, fixed, closed, matrix, points, 6, endGuid);
      const original = search;
      const maximumDistance = original.baselineDistance * 1.2 + 0.1;
      let best = route;
      for (let pass = 0; pass < 8; pass++) {
        const candidate = search.candidates.find(item =>
          item.distance <= maximumDistance && item.penalty < search.baselinePenalty - 1e-6 &&
          item.score < search.baseline - 1e-6);
        if (!candidate) break;
        best = candidate.route;
        progress(`Comparing backtracking alternatives locally ${pass + 1}/8…`);
        await p.pause(0);
        search = p.backtrackCandidates(best, fixed, closed, matrix, points, 6, endGuid);
      }
      const finalPenalty = p.turnPenalty(best, closed);
      return {route: best,
        info: `${pedestrian ? 'Pedestrian backtracking alternatives compared' : 'Sharp-reversal preference applied'} locally; estimated reversal penalty ${Math.round(original.baselinePenalty)}m → ${Math.round(finalPenalty)}m.`};
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
      missions: p.split(route, count, sharedEndpoints, closed).map((chunk, i, chunks) => ({
        missionTitle: `${name} ${String(i + 1).padStart(String(count).length, '0')}-${count}`,
        missionDescription: description,
        portals: chunk.map((v, position) => ({description: '', guid: v.guid, imageUrl: v.imageUrl,
          isOrnamented: false, isStartPoint: false,
          location: {latitude: v.lat, longitude: v.lng}, title: v.title, type: 'PORTAL',
          objective: {type: sharedEndpoints && i < chunks.length - 1 && position === chunk.length - 1
            ? 'CAPTURE_PORTAL' : 'HACK_PORTAL', passphrase_params: {question: '', _single_passphrase: ''}}}))
      }))
    });
    p.draw = () => {
      p.preview.clearLayers();
      const chunks = p.split(p.route, p.syncBannerCount(true), p.ui.querySelector('.shared').checked, p.closed);
      const colors = ['#ffb347', '#54d9ff', '#e08aff', '#7fe895', '#ff8093', '#fff07a'];
      if (p.walk) {
        // Separate lines preserve any gaps in fallback geometry. Draw first
        // so mission links and portal markers remain above the walking trace.
        L.polyline(p.walk.legs.filter(leg => !leg.estimated).map(leg => leg.line).filter(line => line.length > 1),
          {color: '#a8adb2', weight: 3, opacity: 0.5, interactive: false}).addTo(p.preview);
        if (p.walk.hasEstimates) L.polyline(p.walk.legs.filter(leg => leg.estimated).map(leg => leg.line),
          {color: '#a8adb2', weight: 3, opacity: 0.7, dashArray: '6 7', interactive: false}).addTo(p.preview);
      } else {
        L.polyline(p.route.map(v => [v.lat, v.lng]), {color: '#aaa', weight: 2, dashArray: '5 8', interactive: false}).addTo(p.preview);
      }
      const legend = p.ui.querySelector('.legend');
      if (legend) {
        legend.replaceChildren();
        if (p.walk) {
          const item = document.createElement('div'); item.style.color = '#a8adb2';
          item.textContent = 'Grey trace: calculated walking path'; legend.append(item);
          if (p.walk.hasEstimates) {
            const estimate = document.createElement('div'); estimate.style.color = '#a8adb2';
            estimate.textContent = `Dashed grey: straight-line estimates (${(p.walk.estimatedDistance / 1000).toFixed(2)} km; time estimated at 1.4 m/s)`;
            legend.append(estimate);
          }
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
        if (p.walk && p.walkAccess?.get(portal.guid)?.offPath) label.textContent += ' • No mapped path closer than 40m; straight-line estimate';
        L.circleMarker([portal.lat, portal.lng], {radius: shared ? 8 : 5,
          color: shared ? '#fff' : colors[missions[0] % colors.length], fillOpacity: 1})
          .bindTooltip(label).addTo(p.preview);
      });
      const meters = p.route.slice(1).reduce((sum, v, i) => sum + p.distance(p.route[i], v), 0) + (p.closed ? p.distance(p.route[p.route.length - 1], p.route[0]) : 0);
      const distance = p.walk ? p.walk.distance : (p.interactionTravel?.distance ?? meters);
      const result = [`Ready to export: ${p.route.length} portals in ${chunks.length} mission${chunks.length === 1 ? '' : 's'}`,
        `mission sizes ${chunks.map(c => c.length).join(', ')}`,
        `${(distance / 1000).toFixed(2)} km${p.walk ? ` (~${Math.round(p.walk.duration / 60)} min moving)` : ' estimated'}`];
      if (p.closed) result.push('returns to start');
      if (p.ui.querySelector('.shared').checked) result.push('shared mission endpoints');
      if (p.walk?.hasEstimates) result.push(`${(p.walk.estimatedDistance / 1000).toFixed(2)} km uses straight-line estimates`);
      if (p.backtrackingEnabled && p.backtrackingInfo) result.push(p.backtrackingInfo.replace(/[.\s]+$/, ''));
      let summary = result.join(' • ') + '.';
      if (p.walk?.warnings?.length) summary += ` Review: ${p.walk.warnings.join(' ')}`;
      p.say(summary);
      p.preview.addTo(window.map);
    };
    p.open = () => {
      if (p.ui) {
        p.refreshKeyState().catch(e => p.say(e.message));
        window.dialog({id: 'mission-router', title: 'Mission Route Planner v0.11.4', html: p.ui, width: 440}); return;
      }
      const ui = p.ui = document.createElement('div');
      ui.className = 'mission-router-ui';
      ui.innerHTML = `<style>
        .mission-router-ui h3,.mission-router-ui h4{margin:0 0 6px}.mission-router-ui h3 small{font-weight:normal;opacity:.7}
        .mission-router-ui section{margin:0 0 14px}.mission-router-ui .mr-help{margin:4px 0 8px;opacity:.85}
        .mission-router-ui label{display:block;margin:7px 0}.mission-router-ui select,.mission-router-ui input[type="text"],.mission-router-ui textarea{box-sizing:border-box;width:100%}
        .mission-router-ui .portals{max-height:180px;overflow:auto;margin:8px 0;padding:4px 6px;border:1px solid rgba(128,128,128,.45)}
        .mission-router-ui .portals label{margin:3px 0}.mission-router-ui .mr-empty{margin:4px;opacity:.7}
        .mission-router-ui details{margin:8px 0}.mission-router-ui summary{cursor:pointer;font-weight:bold}
        .mission-router-ui .mr-inline{display:flex;gap:6px;align-items:center}.mission-router-ui .mr-inline input{width:70px}
        .mission-router-ui .mr-actions{display:flex;gap:6px;flex-wrap:wrap}.mission-router-ui .status{margin:10px 0 0;padding-top:8px;border-top:1px solid rgba(128,128,128,.45)}
        .mission-router-ui .banner-hint,.mission-router-ui .end-hint{margin:5px 0 8px}
      </style>
        <h3>Mission Route Planner <small>v0.11.4</small></h3>
        <p class="mr-help">Build a mission route from portals loaded inside your Draw Tools areas.</p>
        <section><h4>1. Collect portals</h4>
          <p class="mr-help">Draw one or more areas. If portals are missing, pan to load them and scan again.</p>
          <button class="scan">Scan drawn areas</button> <button class="clear">Clear collection</button>
          <div class="portals"><p class="mr-empty">No portals collected yet.</p></div>
        </section>
        <section><h4>2. Configure route</h4>
          <label>Routing mode <select class="mode"><option value="straight">Straight-line estimate (offline)</option><option value="walk">Pedestrian paths</option></select></label>
          <div class="walking-settings" hidden>
            <p class="key-status">${bridge.hasKey ? 'API key set for this page session.' : 'No API key set.'}</p>
            <div class="mr-actions"><button class="set-key" type="button">Manage API key</button></div>
            <p class="mr-help"><a href="https://account.heigit.org/" target="_blank" rel="noopener noreferrer">Get an API key</a>. The key stays outside the IITC page and is cleared when you reload it.</p>
            <label><input class="visit-passing" type="checkbox" checked> Visit portals when within 30 m</label>
          </div>
          <label>Start portal <select class="start"><option value="">Automatic</option></select></label>
          <label>Finish portal <select class="end"><option value="">Automatic</option></select></label>
          <p class="end-hint" hidden>The route will finish at its start; the finish selection is ignored.</p>
          <label class="mr-inline">Mission count <input class="count" type="number" min="1" step="1" value="1"></label>
          <details><summary>Mission and route options</summary>
            <label><input class="maximize-banner" type="checkbox"> Maximize banner length</label>
            <p class="banner-hint" role="status" aria-live="polite" hidden></p>
            <label><input class="shared" type="checkbox"> Share endpoints between missions</label>
            <label><input class="closed" type="checkbox"> Return to the starting portal</label>
            <label><input class="backtracking" type="checkbox"> Prefer less backtracking</label>
          </details>
        </section>
        <section><h4>3. Optimize and export</h4>
          <label>Banner / mission name <input class="name" type="text" value="My mission"></label>
          <label>Mission description <textarea class="description" rows="3" placeholder="Describe the route for agents"></textarea></label>
          <div class="mr-actions"><button class="optimize">Optimize route</button><button class="cancel" disabled>Cancel</button><button class="export">Export UMM JSON</button></div>
          <p class="mr-help"><a href="https://github.com/ec560/ingress-mission-router#review-and-debug-a-route" target="_blank" rel="noopener noreferrer">Route help and troubleshooting</a></p>
          <div class="legend"></div><p class="status" role="status" aria-live="polite">Draw an area and scan it to begin.</p>
        </section>`;
      const on = (selector, action) => { ui.querySelector(selector).onclick = async () => {
        if (p.busy) return;
        try { await action(); } catch (e) { p.say(e.message); }
      }; };
      ui.querySelector('.cancel').onclick = () => p.controller?.abort();
      ui.querySelector('.mode').onchange = async () => {
        ui.querySelector('.walking-settings').hidden = ui.querySelector('.mode').value !== 'walk';
        if (ui.querySelector('.mode').value === 'walk') try { await p.refreshKeyState(); } catch (e) {
          p.invalidate(); p.say(e.message); return;
        }
        p.invalidate(); p.say('Routing mode changed. Optimize again.');
      };
      on('.set-key', async () => {
        const state = await p.bridge('configure-key'); p.showKeyState(state.hasKey);
        p.say(state.changed ? (state.hasKey ? 'API key set for this page session.' : 'API key removed.') : 'API key unchanged.');
      });
      on('.scan', p.scan);
      on('.clear', () => { p.walkCache = null; p.matrixProgressCache = null; p.walkAccess = null; p.pool.clear(); p.excluded.clear(); p.invalidate(); p.renderPortals(); p.say('Collection cleared.'); });
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
          const walking = ui.querySelector('.mode').value === 'walk';
          const fixed = ui.querySelector('.start').value;
          const endGuid = ui.querySelector('.closed').checked ? '' : ui.querySelector('.end').value;
          if (endGuid && !points.some(v => v.guid === endGuid)) throw Error('The selected end portal is excluded.');
          if (fixed && endGuid === fixed) throw Error('Choose different start and end portals, or enable return-to-start.');
          if (fixed && !points.some(v => v.guid === fixed)) throw Error('The selected start portal is excluded.');
          const rawMatrix = walking ? await p.walkMatrix(points, p.say) : points.map(a => points.map(b => p.distance(a, b)));
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
          const backtracking = ui.querySelector('.backtracking').checked;
          let backtrackingInfo = '';
          if (backtracking) {
            const refined = await p.reduceBacktracking(route, fixed, closed, matrix, points, p.say, endGuid, walking);
            route = refined.route; backtrackingInfo = refined.info;
          }
          const walkingRoute = closed ? route.concat([route[0]]) : route;
          let geometry = walking ? await p.walkGeometry(walkingRoute, p.say) : null;
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
    setup.info = {pluginId: 'mission-router', script: {name: 'Mission Route Planner', version: '0.11.4'}};
    if (!window.bootPlugins) window.bootPlugins = [];
    window.bootPlugins.push(setup);
    if (window.iitcLoaded) setup();
  }
  const script = document.createElement('script');
  script.textContent = '(' + wrapper.toString() + ')(' + JSON.stringify({requestEvent, responseEvent, hasKey: keyState().hasKey}) + ');';
  (document.body || document.head || document.documentElement).appendChild(script); script.remove();
})();
