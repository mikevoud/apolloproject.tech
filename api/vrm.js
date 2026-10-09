// Vercel Serverless Function  →  /api/vrm
//
// Env vars (Vercel → Project → Settings → Environment Variables), then redeploy:
//   VRM_TOKEN            your VRM access token
//   VRM_INSTALLATION_ID  your installation id
//
//   /api/vrm?type=live   current values, already translated to the names the page expects
//   /api/vrm?type=stats  last 7 days totals (kWh) + peak solar power
//   /api/vrm?type=diag   RAW list of every value your system reports (use it to check/adjust the mapping)
//   /api/vrm?type=raw    RAW answer of VRM "stats?type=live_feed"

const BASE = 'https://vrmapi.victronenergy.com/v2/installations/';

async function vrm(path, token, id, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(BASE + encodeURIComponent(id) + path, {
      headers: { 'X-Authorization': 'Token ' + token },
      signal: ctrl.signal
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 504 : 502, json: null, text: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// Pick values out of the "diagnostics" list by dbus path (stable) or description (fallback)
function normalizeLive(records) {
  const list = Array.isArray(records) ? records : [];
  const val = (r) => num(r.rawValue !== undefined ? r.rawValue : r.value);
  const by = (fn) => list.filter(fn).map(val).filter((v) => v !== null);
  const path = (r) => String(r.dbusPath || '');
  const svc = (r) => String(r.dbusServiceType || '');
  const desc = (r) => String(r.description || r.dataAttributeName || '');

  const first = (arr) => (arr.length ? arr[0] : null);

  const soc = first(by((r) => svc(r) === 'battery' && path(r) === '/Soc')) ??
              first(by((r) => /state of charge/i.test(desc(r))));
  const bv  = first(by((r) => svc(r) === 'battery' && path(r) === '/Dc/0/Voltage')) ??
              first(by((r) => /^battery voltage$/i.test(desc(r))));
  const bc  = first(by((r) => svc(r) === 'battery' && path(r) === '/Dc/0/Current')) ??
              first(by((r) => /^battery current$/i.test(desc(r))));
  const bt  = first(by((r) => svc(r) === 'battery' && path(r) === '/Dc/0/Temperature')) ??
              first(by((r) => /battery temperature/i.test(desc(r))));

  // all MPPT chargers added together
  const pv = by((r) => svc(r) === 'solarcharger' && path(r) === '/Yield/Power');
  const pvFallback = by((r) => /^pv power$/i.test(desc(r)));
  const yieldToday = by((r) => svc(r) === 'solarcharger' && path(r) === '/History/Daily/0/Yield');
  const yieldFallback = by((r) => /^yield today$/i.test(desc(r)));

  const acCons = by((r) => /^\/Ac\/Consumption\/L\d\/Power$/.test(path(r)) || /^\/Ac\/ConsumptionOnOutput\/L\d\/Power$/.test(path(r)));
  const acConsFallback = by((r) => /^ac consumption/i.test(desc(r)));
  const grid = by((r) => /^\/Ac\/Grid\/L\d\/Power$/.test(path(r)));

  const solar = pv.length ? sum(pv) : (pvFallback.length ? sum(pvFallback) : null);
  const yt = yieldToday.length ? sum(yieldToday) : (yieldFallback.length ? sum(yieldFallback) : null);
  const cons = acCons.length ? sum(acCons) : (acConsFallback.length ? sum(acConsFallback) : null);

  const out = {};
  if (soc !== null) out.soc = soc;
  if (bv !== null) out.battery_voltage = bv;
  if (bc !== null) out.battery_current = bc;
  if (bt !== null) out.temperature = bt;
  if (solar !== null) out.solar_power = solar;
  if (yt !== null) out.total_solar_yield = Math.round(yt * 100) / 100;
  if (cons !== null) out.consumption = cons;
  out.grid_power = grid.length ? sum(grid) : 0;
  return out;
}

// Fallback: the simple live_feed answer (series of [timestamp, value]) -> flat values
function normalizeLiveFeed(json) {
  const rec = (json && json.records) || {};
  const tot = (json && json.totals) || {};
  const last = (arr) => (Array.isArray(arr) && arr.length ? num(arr[arr.length - 1][1]) : null);
  const out = {};
  const bv = last(rec.bv); if (bv !== null) out.battery_voltage = bv;
  const pdc = last(rec.Pdc); if (pdc !== null) out.solar_power = pdc;
  const ty = num(tot.total_solar_yield); if (ty !== null) out.total_solar_yield = Math.round(ty * 100) / 100;
  out.grid_power = 0;
  return out;
}

// find the first [[ts, value, ...], ...] list inside an arbitrary JSON structure
function findSeries(node) {
  if (Array.isArray(node) && node.length && Array.isArray(node[0])) return node;
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const r = findSeries(node[k]);
      if (r) return r;
    }
  }
  return null;
}

// Find the temperature of the three named devices: match the device name from VRM "system-overview"
// (custom names like "Left 150/45", "Right 150/45", "Multiplus 6k5"), then read its temperature
// attribute from the diagnostics list (joined by device instance).
const TEMP_TARGETS = [
  { key: 'temp_left',  re: /left/i },
  { key: 'temp_right', re: /right/i },
  { key: 'temp_multi', re: /multi/i }
];

function pickTemps(list, overview) {
  const records = Array.isArray(list) ? list : [];
  const devices = (overview && overview.records && Array.isArray(overview.records.devices)) ? overview.records.devices : [];
  const values = {}, info = {};

  TEMP_TARGETS.forEach(function (t) {
    // 1) device by its VRM name (custom name, then product name)
    const dev = devices.find(function (d) { return t.re.test(String(d.customName || d.name || '')) || t.re.test(String(d.productName || '')); });
    let cands = [];
    if (dev && dev.instance !== undefined) {
      cands = records.filter(function (r) { return String(r.instance) === String(dev.instance); });
    }
    // 2) fallback: diagnostics rows that carry the device name themselves
    if (!cands.length) {
      cands = records.filter(function (r) { return t.re.test(String(r.Device || r.deviceName || r.customName || '')); });
    }
    const temps = cands.filter(function (r) {
      return /temp/i.test(String(r.description || r.dataAttributeName || '')) || /Temperature$/.test(String(r.dbusPath || ''));
    });
    if (!temps.length) return;
    const score = function (r) {
      const d = String(r.description || r.dataAttributeName || '');
      let sc = 0;
      if (/internal|charger|inverter|multi|device|heatsink|transformer|power stage/i.test(d)) sc += 3;
      if (/^\/Temperature$/.test(String(r.dbusPath || ''))) sc += 2;
      if (/battery/i.test(d)) sc -= 1;
      return sc;
    };
    temps.sort(function (a, b) { return score(b) - score(a); });
    const best = temps[0];
    const v = num(best.rawValue !== undefined ? best.rawValue : best.value);
    if (v === null) return;
    values[t.key] = Math.round(v * 10) / 10;
    info[t.key] = { device: dev ? (dev.customName || dev.name) : null, instance: best.instance, attribute: best.description || best.dataAttributeName, path: best.dbusPath || null };
  });
  return { values: values, info: info, devices: devices.map(function (d) { return { name: d.customName || d.name, product: d.productName, instance: d.instance }; }) };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  const token = process.env.VRM_TOKEN;
  const id = process.env.VRM_INSTALLATION_ID;
  if (!token || !id) return res.status(500).json({ error: 'Server is not configured (missing environment variables)' });

  const type = req.query.type;
  const send = (code, body, cache) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (cache) res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(code).send(typeof body === 'string' ? body : JSON.stringify(body));
  };

  try {
    if (type === 'diag') {
      const r = await vrm('/diagnostics?count=1000', token, id);
      return send(r.status, r.text, false);
    }
    if (type === 'raw') {
      const r = await vrm('/stats?type=live_feed', token, id);
      return send(r.status, r.text, false);
    }
    if (type === 'live') {
      const pair = await Promise.all([vrm('/diagnostics?count=1000', token, id, 8000), vrm('/system-overview', token, id, 6000)]);
      const r = pair[0], overview = pair[1];
      let records = r.ok && r.json ? normalizeLive(r.json.records) : {};
      if (Object.keys(records).length > 1) {
        const tp = pickTemps(r.json.records, overview.json);
        Object.assign(records, tp.values);
        return send(200, { success: true, source: 'diagnostics', records: records, found: Object.keys(records), temps: tp.info }, true);
      }
      // diagnostics failed / empty -> fall back to the simpler live_feed
      const f = await vrm('/stats?type=live_feed', token, id, 6000);
      if (f.ok && f.json) {
        records = Object.assign(normalizeLiveFeed(f.json), records);
        return send(200, { success: true, source: 'live_feed', diagStatus: r.status, diagNote: r.ok ? 'no matching values' : r.text.slice(0, 200), records: records, found: Object.keys(records) }, true);
      }
      return send(502, { success: false, error: 'VRM did not answer', diagnostics: { status: r.status, note: r.text.slice(0, 200) }, live_feed: { status: f.status, note: f.text.slice(0, 200) } }, false);
    }
    if (type === 'stats') {
      const end = Math.floor(Date.now() / 1000);
      const start = end - 7 * 24 * 60 * 60;
      const q = '&start=' + start + '&end=' + end;
      const [kwh, venus] = await Promise.all([
        vrm('/stats?type=kwh&interval=days' + q, token, id),
        vrm('/stats?type=venus&interval=hours' + q, token, id)
      ]);
      if (!kwh.ok || !kwh.json) return send(kwh.status || 502, { success: false, error: 'VRM kwh stats failed', status: kwh.status }, false);
      const rec = kwh.json.records || {};
      const total = (code) => (Array.isArray(rec[code]) ? sum(rec[code].map((p) => num(p[1]) || 0)) : 0);
      // Pc = PV→consumers, Pb = PV→battery, Pg = PV→grid, Bc = battery→consumers, Gc = grid→consumers
      const solar = total('Pc') + total('Pb') + total('Pg');
      const consumption = total('Pc') + total('Bc') + total('Gc');
      let peak = 0;
      const pdc = venus.json && venus.json.records && venus.json.records.Pdc;
      if (Array.isArray(pdc)) peak = Math.max(0, ...pdc.map((p) => num(p[1]) || 0));
      // per-day split of consumption by source: solar direct (Pc), battery (Bc), grid (Gc)
      const dayMap = {};
      [['Pc', 'solar'], ['Bc', 'battery'], ['Gc', 'grid']].forEach(function (pair) {
        (Array.isArray(rec[pair[0]]) ? rec[pair[0]] : []).forEach(function (pt) {
          const ts = pt[0];
          dayMap[ts] = dayMap[ts] || { ts: ts, solar: 0, battery: 0, grid: 0 };
          dayMap[ts][pair[1]] = Math.round((num(pt[1]) || 0) * 100) / 100;
        });
      });
      const daily = Object.keys(dayMap).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return dayMap[k]; });
      return send(200, { success: true, records: {
        daily: daily,
        total_consumption_7d: Math.round(consumption * 10) / 10,
        total_solar_yield_7d: Math.round(solar * 10) / 10,
        peak_solar_power: Math.round(peak)
      } }, true);
    }
    if (type === 'temps') {
      const pair = await Promise.all([vrm('/diagnostics?count=1000', token, id, 8000), vrm('/system-overview', token, id, 6000)]);
      const list = (pair[0].json && Array.isArray(pair[0].json.records)) ? pair[0].json.records : [];
      const tp = pickTemps(list, pair[1].json);
      const all = list.filter(function (r) { return /temp/i.test(String(r.description || '')) || /Temperature$/.test(String(r.dbusPath || '')); })
        .map(function (r) { return { instance: r.instance, device: r.Device || null, description: r.description, path: r.dbusPath || null, value: r.formattedValue || r.rawValue }; });
      return send(200, { picked: tp.values, how: tp.info, devices: tp.devices, all_temperature_attributes: all }, false);
    }
    if (type === 'stages') {
      // share of time in each charge stage (Bulk / Absorption / Float) over the last 24 h
      const d = await vrm('/diagnostics?count=1000', token, id, 8000);
      const list = (d.json && Array.isArray(d.json.records)) ? d.json.records : [];
      const inst = Array.from(new Set(list
        .filter(function (r) { return r.code === 'ScS' || (r.dbusServiceType === 'solarcharger' && r.dbusPath === '/State'); })
        .map(function (r) { return r.instance; })
        .filter(function (x) { return x !== undefined && x !== null; })));
      if (!inst.length) return send(200, { success: false, error: 'No solar charger found in diagnostics', diagStatus: d.status }, false);

      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 60 * 60;
      const graphs = await Promise.all(inst.map(function (i) {
        return vrm('/widgets/Graph?attributeIds%5B%5D=85&instance=' + encodeURIComponent(i) + '&start=' + start + '&end=' + end, token, id, 8000);
      }));

      const hours = { bulk: 0, absorption: 0, float: 0, other: 0 };
      let samples = 0, sample = null;
      graphs.forEach(function (g) {
        if (!g.ok || !g.json) return;
        const data = g.json.records && g.json.records.data;
        const series = findSeries(data && data['85'] !== undefined ? data['85'] : data);
        if (!series || series.length < 2) return;
        if (!sample) sample = series.slice(0, 3);
        for (let k = 0; k < series.length; k++) {
          const t0 = num(series[k][0]);
          const t1 = k + 1 < series.length ? num(series[k + 1][0]) : end * 1000;
          const v = Math.round(num(series[k][1]));
          if (t0 === null || t1 === null || !Number.isFinite(v)) continue;
          const h = Math.min(Math.max(t1 - t0, 0), 2 * 3600 * 1000) / 3600000; // cap gaps at 2 h
          samples++;
          if (v === 3) hours.bulk += h;
          else if (v === 4) hours.absorption += h;
          else if (v === 5) hours.float += h;
          else if (v === 0 || v === 245 || v === 252) continue;   // off / external control: not charging
          else hours.other += h;                                   // storage, equalize, ...
        }
      });
      const total = hours.bulk + hours.absorption + hours.float + hours.other;
      if (!total) return send(200, { success: false, error: 'No charge-state history returned', samples: samples, sample: sample }, false);
      Object.keys(hours).forEach(function (k) { hours[k] = Math.round(hours[k] * 100) / 100; });
      return send(200, { success: true, records: hours, samples: samples, sample: sample }, true);
    }
    return send(400, { error: 'Use ?type=live, stats, stages, temps, diag or raw' }, false);
  } catch (err) {
    return send(502, { error: 'Upstream request to VRM failed' }, false);
  }
};
