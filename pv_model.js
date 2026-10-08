/*!
 * Apollo Project - PV production & shading model  (pv_model.js)
 *
 * One self-contained script. It works in the browser (window.PVModel) and in Node (require).
 * Every number the model uses is in PVModel.DEFAULTS, so nothing is hidden inside the code.
 *
 * What it does, for each month (representative mid-month day, 6 minute steps):
 *   1. Sun position for the site latitude.
 *   2. Splits the monthly horizontal irradiation (GHI) into direct and diffuse light
 *      (clear-sky shape scaled to your monthly value, Erbs diffuse fraction).
 *   3. Transposes it onto each PV field (direction + tilt), including ground reflection.
 *   4. Shading: direct light is cut whenever the sun is below the horizon profile built from
 *      the surrounding buildings; diffuse light is scaled by the sky-view factor.
 *   5. Losses: angle of incidence, low light, cell temperature, soiling, wiring/mismatch,
 *      charger/inverter efficiency and module ageing.
 *   6. Energy = kWh per kWp per day  x  field kWp  x  days in the month  x  calibration.
 *
 * Conventions: azimuths are compass degrees (0 = North, 90 = East, 180 = South, 270 = West).
 */
(function (root) {
  'use strict';

  var MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var MONTH_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];
  var STEP_H = 0.1; // time step in hours

  // ------------------------------------------------------------------ defaults
  var DEFAULTS = {
    site: {
      latitude: 37.94,      // degrees, north positive
      panelHeight: 9.2,     // m above ground (roof + mounting)
      albedo: 0.2,          // ground reflectance
      baseSkyline: 3.0,     // general urban skyline elevation in degrees
      calibration: 1.0      // multiply the result by (real yield / modelled yield) once you have measurements
    },
    climate: {
      // Monthly mean values, January..December (Athens area). Replace with data for your site.
      ghi: [2.05, 2.9, 4.1, 5.4, 6.5, 7.4, 7.5, 6.7, 5.2, 3.6, 2.4, 1.8], // kWh/m2/day on a horizontal plane
      tmin: [6, 6.5, 8, 11.5, 16, 21, 24, 24, 20, 15.5, 11.5, 8],        // degC, mean daily minimum
      tmax: [13.5, 14.5, 17, 21, 26.5, 31.5, 34, 34, 29.5, 24.5, 19, 15], // degC, mean daily maximum
      soiling: [3, 3, 3, 4, 4, 5, 5, 5, 5, 4, 3, 3]                       // % lost to dirt (low tilt = weak rain cleaning)
    },
    losses: {
      wiring: 3,            // % wiring + module mismatch
      converter: 97,        // % MPPT charger / inverter efficiency
      ageing: 5,            // % module degradation so far
      tempCoeff: -0.45,     // % power change per degC above 25 degC (Suntech STP245 class)
      u0: 20,               // Faiman heat-loss constant, W/m2K (close-mounted on an insulated roof)
      u1: 4,                // Faiman wind term, W/m2K per m/s
      wind: 2,              // m/s average wind
      iamB0: 0.05,          // ASHRAE incidence-angle modifier constant for direct light
      diffuseIam: 0.95,     // incidence-angle factor for diffuse + reflected light
      lowLight: 6           // % maximum extra loss at very low irradiance (below 400 W/m2)
    },
    fields: [
      { name: 'East', wp: 2205, azimuth: 90, tilt: 20, tiltUnit: 'percent' },   // 9 x 245 W
      { name: 'West', wp: 2940, azimuth: 270, tilt: 15, tiltUnit: 'percent' }    // 12 x 245 W
    ],
    buildings: [
      // azimuth = direction you look from the panels to the building centre
      // span = how many degrees of the horizon it covers (or give width in m and the span is calculated)
      { name: 'East building', azimuth: 90, height: 17, distance: 15, span: 130, width: 0 },
      { name: 'West building', azimuth: 270, height: 15, distance: 1, span: 130, width: 0 },
      { name: 'North building', azimuth: 0, height: 19, distance: 1, span: 130, width: 0 },
      { name: 'South building', azimuth: 180, height: 19, distance: 17, span: 130, width: 0 }
    ]
  };

  // ------------------------------------------------------------------ helpers
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function mod360(a) { return ((a % 360) + 360) % 360; }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function num(v, fallback) { var n = parseFloat(v); return isFinite(n) ? n : fallback; }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }

  function tiltDegrees(field) {
    var t = Math.max(0, num(field.tilt, 0));
    return field.tiltUnit === 'percent' ? deg(Math.atan(t / 100)) : clamp(t, 0, 90);
  }

  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compassLabel(az) { return COMPASS[Math.round(mod360(az) / 22.5) % 16]; }

  // ------------------------------------------------------------------ horizon from buildings
  function buildHorizon(site, buildings) {
    var base = clamp(num(site.baseSkyline, 3), 0, 60);
    var z = num(site.panelHeight, 9);
    var profile = new Array(360);
    var i;
    for (i = 0; i < 360; i++) profile[i] = base;
    var info = [];

    (buildings || []).forEach(function (b) {
      var d = Math.max(0.1, num(b.distance, 10));
      var h = num(b.height, 0);
      var elev = Math.min(85, deg(Math.atan((h - z) / d)));
      var width = num(b.width, 0);
      var span = width > 0 ? Math.min(175, 2 * deg(Math.atan(width / (2 * d)))) : clamp(num(b.span, 130), 1, 360);
      var az = num(b.azimuth, 0);
      var half = span / 2;
      for (var a = Math.ceil(az - half); a <= Math.floor(az + half); a++) {
        var idx = mod360(a);
        if (elev > profile[idx]) profile[idx] = elev;
      }
      info.push({ name: b.name || '', azimuth: az, height: h, distance: d, elevation: elev, span: span });
    });

    // Fraction of the diffuse sky that stays visible (isotropic sky, horizon blocks cos^2(elevation))
    var svf = 0;
    for (i = 0; i < 360; i++) { var c = Math.cos(rad(profile[i])); svf += c * c; }
    svf /= 360;

    return { profile: profile, skyView: svf, buildings: info };
  }

  // ------------------------------------------------------------------ one representative day
  // Everything that does not depend on the PV field (sun, irradiance, temperature).
  function dayProfile(model, m) {
    var site = model.site, cl = model.climate;
    var phi = rad(num(site.latitude, 38));
    var n = MONTH_DOY[m];
    var dec = rad(23.45 * Math.sin(rad(360 * (284 + n) / 365)));
    var I0n = 1367 * (1 + 0.033 * Math.cos(rad(360 * n / 365)));
    var wsDeg = deg(Math.acos(clamp(-Math.tan(phi) * Math.tan(dec), -1, 1)));

    var start = -wsDeg / 15 + 0.05, stop = wsDeg / 15;
    var N = Math.max(0, Math.ceil((stop - start) / STEP_H - 1e-9));

    var ts = [], cz = [], el = [], az = [], csGhi = [];
    var H0 = 0, Hcs = 0, i;
    for (i = 0; i < N; i++) {
      var t = start + i * STEP_H;
      var om = rad(t * 15);
      var c = clamp(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(om), 0, 1);
      var As = Math.atan2(Math.sin(om), Math.cos(om) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
      var g = c > 0.01 ? 1098 * c * Math.exp(-0.059 / Math.max(c, 0.01)) : 0;
      ts.push(t); cz.push(c); el.push(deg(Math.asin(c))); az.push(mod360(180 + deg(As))); csGhi.push(g);
      H0 += I0n * c * STEP_H / 1000;
      Hcs += g * STEP_H / 1000;
    }

    var Hday = Math.max(0, num(cl.ghi[m], 0));
    var k = Hcs > 0 ? Hday / Hcs : 0;
    var Kt = H0 > 0 ? Hday / H0 : 0;
    var Fd = wsDeg <= 81.4
      ? 1.391 - 3.560 * Kt + 4.189 * Kt * Kt - 2.137 * Kt * Kt * Kt
      : 1.311 - 3.022 * Kt + 3.427 * Kt * Kt - 1.821 * Kt * Kt * Kt;
    Fd = clamp(Fd, 0.15, 1);

    var ghi = [], dif = [], dni = [], Ta = [];
    var tmin = num(cl.tmin[m], 10), tmax = num(cl.tmax[m], 20);
    for (i = 0; i < N; i++) {
      var gh = csGhi[i] * k;
      var df = gh * Fd;
      var bh = gh - df;
      ghi.push(gh); dif.push(df);
      dni.push(cz[i] > 0.05 ? Math.min(bh / Math.max(cz[i], 0.05), 950) : 0);
      Ta.push((tmax + tmin) / 2 + (tmax - tmin) / 2 * Math.cos(2 * Math.PI * (ts[i] + 12 - 15) / 24));
    }
    return { N: N, cz: cz, el: el, az: az, ghi: ghi, dif: dif, dni: dni, Ta: Ta, ghiDay: Hday };
  }

  // ------------------------------------------------------------------ one PV field, one month
  function fieldMonth(model, day, field, horizon, m) {
    var L = model.losses;
    var beta = rad(tiltDegrees(field));
    var planeAz = num(field.azimuth, 180);
    var albedo = num(model.site.albedo, 0.2);
    var svf = horizon.skyView;
    var b0 = num(L.iamB0, 0.05), iamD = num(L.diffuseIam, 0.95);
    var gamma = num(L.tempCoeff, -0.45) / 100;
    var uTot = Math.max(1, num(L.u0, 20) + num(L.u1, 4) * num(L.wind, 2));
    var lowMax = num(L.lowLight, 6) / 100;
    var sys = (1 - clamp(num(model.climate.soiling[m], 0), 0, 100) / 100) *
              (1 - clamp(num(L.wiring, 3), 0, 100) / 100) *
              (clamp(num(L.converter, 97), 1, 100) / 100) *
              (1 - clamp(num(L.ageing, 0), 0, 100) / 100);

    var Hu = 0, Hs = 0, Esum = 0;
    for (var i = 0; i < day.N; i++) {
      var cz = day.cz[i];
      var sinz = Math.sqrt(1 - cz * cz);
      var cosAoi = clamp(cz * Math.cos(beta) + sinz * Math.sin(beta) * Math.cos(rad(day.az[i] - planeAz)), 0, 1);
      var lit = day.el[i] > horizon.profile[Math.round(day.az[i]) % 360] ? 1 : 0;

      var beamU = day.dni[i] * cosAoi;
      var beamS = beamU * lit;
      var difU = day.dif[i] * (1 + Math.cos(beta)) / 2;
      var difS = difU * svf;
      var gr = albedo * day.ghi[i] * (1 - Math.cos(beta)) / 2;

      var poaU = beamU + difU + gr;
      var poaS = beamS + difS + gr;
      var iamB = cosAoi > 0.02 ? clamp(1 - b0 * (1 / cosAoi - 1), 0, 1) : 0;
      var gEff = beamS * iamB + difS * iamD + gr * iamD;

      var Tc = day.Ta[i] + poaS / uTot;
      var low = 1 - lowMax * clamp((400 - gEff) / 400, 0, 1);
      var pRel = (gEff / 1000) * (1 + gamma * (Tc - 25)) * low;

      Hu += poaU * STEP_H / 1000;
      Hs += poaS * STEP_H / 1000;
      Esum += pRel * STEP_H;
    }
    var E = Esum * sys; // kWh per kWp per day
    var ghiDay = day.ghiDay;
    return {
      ghi: ghiDay,
      poaUnshaded: Hu,          // kWh/m2/day on the tilted plane, no buildings
      poaShaded: Hs,            // kWh/m2/day on the tilted plane, with buildings
      orientation: ghiDay > 0 ? Hu / ghiDay : 0,   // gain/loss of tilt + direction vs horizontal
      shading: Hu > 0 ? Hs / Hu : 0,               // share of light that survives the buildings
      pr: Hs > 0 ? E / Hs : 0,                     // technical performance ratio (losses after shading)
      factor: ghiDay > 0 ? E / ghiDay : 0,         // kWh per kWp per kWh/m2 horizontal  (used by the forecast)
      kwhPerKwpDay: E
    };
  }

  // ------------------------------------------------------------------ public: run
  function normalise(params) {
    var p = deepCopy(DEFAULTS);
    if (params) {
      ['site', 'losses'].forEach(function (sec) {
        if (params[sec]) Object.keys(p[sec]).forEach(function (k) { if (params[sec][k] !== undefined) p[sec][k] = num(params[sec][k], p[sec][k]); });
      });
      if (params.climate) ['ghi', 'tmin', 'tmax', 'soiling'].forEach(function (k) {
        if (Array.isArray(params.climate[k]) && params.climate[k].length === 12) p.climate[k] = params.climate[k].map(function (v, i) { return num(v, p.climate[k][i]); });
      });
      if (Array.isArray(params.fields)) p.fields = deepCopy(params.fields);
      if (Array.isArray(params.buildings)) p.buildings = deepCopy(params.buildings);
    }
    return p;
  }

  function run(params) {
    var model = normalise(params);
    var horizon = buildHorizon(model.site, model.buildings);
    var days = [];
    for (var m = 0; m < 12; m++) days.push(dayProfile(model, m));
    var cal = num(model.site.calibration, 1);

    var fields = model.fields.map(function (f) {
      var kwp = Math.max(0, num(f.wp, 0)) / 1000;
      var rows = [];
      for (var m = 0; m < 12; m++) {
        var r = fieldMonth(model, days[m], f, horizon, m);
        r.month = m + 1;
        r.days = MONTH_DAYS[m];
        r.kwh = r.kwhPerKwpDay * kwp * MONTH_DAYS[m] * cal;
        rows.push(r);
      }
      var yearKwh = sum(rows.map(function (r) { return r.kwh; }));
      var w = function (key) { return sum(rows.map(function (r) { return r[key] * r.days; })); };
      var ghiY = w('ghi'), huY = w('poaUnshaded'), hsY = w('poaShaded'), eY = w('kwhPerKwpDay');
      return {
        name: f.name || 'Field', wp: num(f.wp, 0), kwp: kwp, azimuth: num(f.azimuth, 180), tiltDeg: tiltDegrees(f),
        months: rows, yearKwh: yearKwh,
        specificYield: kwp > 0 ? yearKwh / kwp : 0,                // kWh per kWp per year
        orientation: ghiY > 0 ? huY / ghiY : 0,
        shading: huY > 0 ? hsY / huY : 0,
        pr: hsY > 0 ? eY / hsY : 0,
        factor: ghiY > 0 ? eY / ghiY : 0
      };
    });

    var months = [];
    for (var mi = 0; mi < 12; mi++) {
      var tot = sum(fields.map(function (f) { return f.months[mi].kwh; }));
      months.push({ month: mi + 1, days: MONTH_DAYS[mi], ghi: model.climate.ghi[mi], kwh: tot, kwhPerDay: tot / MONTH_DAYS[mi] });
    }
    var yearKwh = sum(months.map(function (x) { return x.kwh; }));
    var kwpTot = sum(fields.map(function (f) { return f.kwp; }));
    return { model: model, horizon: horizon, fields: fields, months: months, yearKwh: yearKwh, kwp: kwpTot, specificYield: kwpTot > 0 ? yearKwh / kwpTot : 0 };
  }

  // ------------------------------------------------------------------ sun path (for drawing)
  function sunPath(latitude, doy, stepHours) {
    var phi = rad(latitude);
    var dec = rad(23.45 * Math.sin(rad(360 * (284 + doy) / 365)));
    var wsDeg = deg(Math.acos(clamp(-Math.tan(phi) * Math.tan(dec), -1, 1)));
    var pts = [];
    for (var t = -wsDeg / 15; t <= wsDeg / 15 + 1e-9; t += (stepHours || 0.25)) {
      var om = rad(t * 15);
      var c = clamp(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(om), 0, 1);
      var As = Math.atan2(Math.sin(om), Math.cos(om) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
      pts.push({ az: mod360(180 + deg(As)), el: deg(Math.asin(c)) });
    }
    return pts;
  }

  var api = {
    DEFAULTS: DEFAULTS,
    MONTH_DAYS: MONTH_DAYS,
    run: run,
    buildHorizon: buildHorizon,
    sunPath: sunPath,
    tiltDegrees: tiltDegrees,
    compassLabel: compassLabel,
    copyDefaults: function () { return deepCopy(DEFAULTS); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PVModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
