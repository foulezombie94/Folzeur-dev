
(function () {
  "use strict";

  /* ============================================================
     01 · SOURCE — the mark, verbatim. Eight closed subpaths:
     one core hexagon, six interlocking arms, one outer contour.
     ============================================================ */
  var SOURCE_D =
    "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 " +
    "2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759" +
    "a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737" +
    "l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 " +
    "2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095" +
    "-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712" +
    ".928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33" +
    "L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927" +
    "l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238" +
    ".238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617" +
    "c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423" +
    "c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9" +
    "c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71" +
    "c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616" +
    "c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756" +
    "C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19" +
    "-.999.19-1.498 0-3.401-2.759-5.946-5.946-5.947-.642 0-1.26.095-1.88.31" +
    "A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 " +
    "0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 " +
    "5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z";

  /* The wordmark as OpenAI sets it — the official outlines, taken from
     the public-domain lockup (simple geometric shapes, below the
     threshold of originality). Filled, never stroked.            */
  var WORD_D =
    "M444.7,68.2c-47.3,0-86.1,38.7-86.1,86.1s38.7,86.1,86.1,86.1s86.1-38.5,86.1-86.1S492." +
    "2,68.2,444.7,68.2z M444.7,209.5c-29.4,0-53.1-24.1-53.1-55.2S415.3,99,444.7,99c29.4,0" +
    ",53.1,24.1,53.1,55.2S474.1,209.5,444.7,209.5zM617.7,116c-15.5,0-30.6,6.2-38.5,16.7v-" +
    "14.3h-31.1v167.3h31.1v-60.5c7.9,9.8,22.5,15.1,38.5,15.1c33.5,0,59.8-26.3,59.8-62.2S6" +
    "51.2,116,617.7,116z M612.5,213.3c-17.7,0-33.5-13.9-33.5-35.1s15.8-35.1,33.5-35.1c17." +
    "7,0,33.5,13.9,33.5,35.1S630.2,213.3,612.5,213.3zM750.6,116c-33.9,0-60.7,26.5-60.7,62" +
    ".2s23.4,62.2,61.7,62.2c31.3,0,51.4-18.9,57.6-40.2h-30.4c-3.8,8.8-14.6,15.1-27.5,15.1" +
    "c-16,0-28.2-11.2-31.1-27.3h90.4v-12.2C810.6,143.2,787.9,116,750.6,116z M720.5,165.9c" +
    "3.3-15.1,15.8-24.9,30.8-24.9c16,0,28.2,10.5,29.6,24.9H720.5zM893.3,116c-13.9,0-28.4," +
    "6.2-35.1,16.5v-14.1h-31.1v119.5h31.1v-64.3c0-18.6,10-30.8,26.3-30.8c15.1,0,23.2,11.5" +
    ",23.2,27.5v67.6h31.1v-72.7C938.8,135.6,920.6,116,893.3,116zM1018.3,70.6l-67.6,167.3h" +
    "33.2l14.3-36.6h77l14.3,36.6h33.7l-67.2-167.3H1018.3z M1009,173.6l27.7-70l27.5,70H100" +
    "9zM1167.5,70.6H1136v167.3h31.6V70.6z";
  /* measured off that same lockup: cap height, full width, and the
     anchor at the horizontal centre of the cap box */
  var WORD_CAP = 172.2, WORD_WIDTH = 809;
  var WORD_AX = 763.1, WORD_AY = 154.3;
  var WORD_ASPECT = 4.698;            /* width / cap height */
  /* the six letters, kept apart so each can be moved on its own */
  var WORD_LETTERS = [
    /* O */
    "M444.7,68.2c-47.3,0-86.1,38.7-86.1,86.1s38.7,86.1,86.1,86.1s86.1-38.5,86.1-86.1S" +
    "492.2,68.2,444.7,68.2z M444.7,209.5c-29.4,0-53.1-24.1-53.1-55.2S415.3,99,444.7,9" +
    "9c29.4,0,53.1,24.1,53.1,55.2S474.1,209.5,444.7,209.5z",
    /* p */
    "M617.7,116c-15.5,0-30.6,6.2-38.5,16.7v-14.3h-31.1v167.3h31.1v-60.5c7.9,9.8,22.5," +
    "15.1,38.5,15.1c33.5,0,59.8-26.3,59.8-62.2S651.2,116,617.7,116z M612.5,213.3c-17." +
    "7,0-33.5-13.9-33.5-35.1s15.8-35.1,33.5-35.1c17.7,0,33.5,13.9,33.5,35.1S630.2,213" +
    ".3,612.5,213.3z",
    /* e */
    "M750.6,116c-33.9,0-60.7,26.5-60.7,62.2s23.4,62.2,61.7,62.2c31.3,0,51.4-18.9,57.6" +
    "-40.2h-30.4c-3.8,8.8-14.6,15.1-27.5,15.1c-16,0-28.2-11.2-31.1-27.3h90.4v-12.2C81" +
    "0.6,143.2,787.9,116,750.6,116z M720.5,165.9c3.3-15.1,15.8-24.9,30.8-24.9c16,0,28" +
    ".2,10.5,29.6,24.9H720.5z",
    /* n */
    "M893.3,116c-13.9,0-28.4,6.2-35.1,16.5v-14.1h-31.1v119.5h31.1v-64.3c0-18.6,10-30." +
    "8,26.3-30.8c15.1,0,23.2,11.5,23.2,27.5v67.6h31.1v-72.7C938.8,135.6,920.6,116,893" +
    ".3,116z",
    /* A */
    "M1018.3,70.6l-67.6,167.3h33.2l14.3-36.6h77l14.3,36.6h33.7l-67.2-167.3H1018.3z M1" +
    "009,173.6l27.7-70l27.5,70H1009z",
    /* I */
    "M1167.5,70.6H1136v167.3h31.6V70.6z"
  ];
  /* The lockup reads across: mark left, word right, on one line, with
     the mark standing exactly as tall as the letters. Everything below
     is derived from the cap height, the way the brand builds it.     */
  var LOCK_TOTAL = 1.30;              /* block width, in stage widths  */
  var LOCK_GAP = 0.2096;              /* of the cap height             */
  var MARK_RATIO = 1.849;             /* mark height / cap height      */
  var LOCK_SPAN = MARK_RATIO + LOCK_GAP + WORD_ASPECT;

  var CX = 12, CY = 12;                       /* optical center of the mark   */

  /* ============================================================
     02 · SCORE — every beat of the piece lives in one table.
     ============================================================ */
  var CFG = {
    /* ACT 0 — overture: a heart-spark, two beats, a burst of
       emissaries that carry the light to each stroke's seam.     */
    ov: { appearT0: 0.50, appearDur: 0.70,              /* swell…               */
          burst: 1.35, flight: 0.60, flightStagger: 0.05, /* …squeeze, burst    */
          swing: 2.4 },
    cam: { from: 1.13, t0: 0.8, dur: 1.9 },             /* dolly-in             */
    draw: {
      hexT0: 2.20,  hexDur: 0.58,                       /* the core seals first */
      armT0: 2.50,  armDur: 0.82, armStagger: 0.155,    /* six arms, clockwise  */
      outerT0: 3.90, outerDur: 1.25,                    /* the binding contour  */
      chaseLag: 0.07
    },
    ignite:  { t0: 5.35, sweep: 0.90, sigma: 0.55 },    /* radar pass + lock    */
    ambient: { t0: 6.25, fadeIn: 1.1 },
    ext:  { t0: 6.35, dur: 0.70, depth: 0.125 },        /* given its thickness  */
    spin: { t0: 6.70, dur: 2.90, rx: 9 },               /* one full turn        */
    /* ---- the passage: in through the hexagon, and out again ---- */
    dive:   { t0: 9.90 },
    /* the shaft runs on until its mosaic is spent and there is nothing
       left to either side; only then does the word arrive */
    /* the word sets off while the last tiles are still going, so the
       two run into one another instead of leaving a hole */
    word:   { slide0: 12.30, slideDur: 2.45 },
    /* then the word stops being flat and becomes a body with no bottom */
    deep:   { t0: 15.35, dur: 1.15 },
    tilt2:  { t0: 16.20, dur: 1.45, deg: 72 },   /* tips onto its face  */
    road:   { t0: 17.35, dur: 1.15 },            /* sideways only       */
    near:   { t0: 18.30, dur: 1.05,              /* then straight in    */
              /* far enough above that the surface stays wholly in front
                 of the eye — closer and the letter straddles the near
                 plane and there is nothing left to draw */
              flat: 89.2,      /* the face comes level                    */
              high: 0.34,      /* clearance above it, in letter widths    */
              below: 0.45,     /* start this far short of the letter      */
              apron: 5200,     /* the face carried on, in path units      */
              reach: 0.78,     /* how much of that we actually cover      */
              /* At first the road gives out so far off that nothing of
                 it shows — it is simply white to the horizon. Only at
                 the close is that point drawn in towards us.         */
              fog: 16000,
              fogEnd: 55 },
    run:    { t0: 19.10, dur: 2.05 },            /* straight across it  */
    /* the ground has to go while there is still ground to go — a beat
       later and the run has simply left it behind */
    fade:   { t0: 20.30, dur: 0.60 },
    jump:   { t0: 21.55, ordT0: 21.55, dur: 1.45,
              from: 0.10, hold: 0.34 },          /* a speck, then aside */
    reveal2: { t0: 21.55, dur: 0.34, armLag: 0.20, ringLag: 0.44 },
    fall:   { t0: 22.35, dur: 0.68, stagger: 0.11, from: 0.85 },
    idle: { t0: 23.80, fadeIn: 2.0, ry: 6, rx: 3.5,
            fy: 0.15, fx: 0.11 },
    embers:  { life: 0.45 },                            /* pen-tip sparks       */
    shimmer: { every: 9.0, first: 1.2, dur: 1.7, armDelay: 0.05, frac: 0.30, opac: 0.17 },
    trace:   { every: 7.3, first: 4.6, dur: 0.95, frac: 0.22, opac: 0.42 },
    rewind:  { each: 0.42, stagger: 0.05, tail: 0.22 },
    restartAt: 0,                         /* every replay is the whole film   */
    w: { ghost: 0.045, chase: 0.30, main: 0.10, glow: 0.30, comet: 0.11, cometHalo: 0.32 },
    o: { ghostIn: 0.075, ghostRest: 0.032, chaseDraw: 0.14, chaseRest: 0.10,
         main: 0.90, glowBed: 0.10, fill: 0.045, cometBase: 0.5, cometHalo: 0.16 },
    cometFracInner: 0.16, cometFracOuter: 0.055,
    cometPeriods: [4.8, 6.8, -7.6, 5.9, -8.2, 6.3, -7.1],   /* sign = direction */
    cometPeriodsOuter: [11.0, -13.5]
  };

  /* ============================================================
     03 · EASING LIBRARY — real curves, solved numerically.
     ============================================================ */
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, m) { return a + (b - a) * m; }
  function fract(v) { return v - Math.floor(v); }
  function h1(n) { return fract(Math.sin(n * 127.1) * 43758.5453); }  /* deterministic noise */
  function smooth(v) { v = clamp01(v); return v * v * (3 - 2 * v); }
  function gauss(x, sigma) { return Math.exp(-(x * x) / (2 * sigma * sigma)); }
  function angDiff(a, b) {
    var d = (a - b) % (Math.PI * 2);
    if (d > Math.PI)  d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  var ease = {
    linear:     function (t) { return t; },
    inQuad:     function (t) { return t * t; },
    outQuad:    function (t) { return t * (2 - t); },
    inOutQuad:  function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    inCubic:    function (t) { return t * t * t; },
    outCubic:   function (t) { var u = 1 - t; return 1 - u * u * u; },
    inOutCubic: function (t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },
    outExpo:    function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    inOutSine:  function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    /* lands slightly past the mark and settles back — a jump, not a slide */
    outBack:    function (t) {
      t = clamp01(t);
      var c1 = 1.36, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
  };

  /* cubic-bezier(x1,y1,x2,y2) — Newton–Raphson with bisection fallback,
     the same solver the browser uses for CSS timing functions.        */
  function cubicBezier(x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    function sampleX(t)  { return ((ax * t + bx) * t + cx) * t; }
    function sampleY(t)  { return ((ay * t + by) * t + cy) * t; }
    function sampleDX(t) { return (3 * ax * t + 2 * bx) * t + cx; }
    function solveT(x) {
      var t = x, i, d;
      for (i = 0; i < 8; i++) {
        d = sampleDX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= (sampleX(t) - x) / d;
      }
      if (t >= 0 && t <= 1 && Math.abs(sampleX(t) - x) < 1e-4) return t;
      var lo = 0, hi = 1;
      t = x;
      while (lo < hi) {
        var sx = sampleX(t);
        if (Math.abs(sx - x) < 1e-4) return t;
        if (x > sx) lo = t; else hi = t;
        t = (lo + hi) / 2;
        if (hi - lo < 1e-6) break;
      }
      return t;
    }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return sampleY(solveT(x));
    };
  }

  var drawEase   = cubicBezier(0.70, 0.02, 0.16, 1.00);  /* ink: commit, glide, land */
  var sweepEase  = cubicBezier(0.60, 0.05, 0.25, 1.00);
  var settleEase = cubicBezier(0.23, 1.00, 0.32, 1.00);
  var spinEase   = cubicBezier(0.86, 0.00, 0.10, 1.00);  /* creep, hurl, brake */
  var runEase    = cubicBezier(0.42, 0.00, 0.90, 0.78);  /* winds up, then holds */
  var wordEase   = cubicBezier(0.33, 0.00, 0.32, 1.00);  /* the long pull-back */

  /* How far we have flown into the tunnel, in pixels, at any time.
     Keyframed so the dive punches in, the tunnel runs flat out,
     and the way back out is one long reversed sweep.              */
  var FLIGHT_KEYS = [
    { t: 9.90,  v: 0 },
    { t: 10.55, v: 1560, e: cubicBezier(0.55, 0.00, 0.85, 0.55) },
    /* the slopes are matched across 12.20 so the flight passes through
       it at speed instead of stalling to a halt and setting off again */
    { t: 12.20, v: 5200, e: cubicBezier(0.20, 0.55, 0.35, 0.82) },
    /* keep going until the mosaic is spent and both sides are bare */
    { t: 13.70, v: 9600, e: cubicBezier(0.20, 0.20, 0.35, 1.00) },
    { t: 20.75, v: 9600, e: ease.linear },
    /* and home, unseen, while the ground is out */
    { t: 20.95, v: 0,    e: ease.linear }
  ];
  /* How much of the shaft is showing. It swells as we enter, fades out
     to leave the word alone in the dark, and comes back for the way
     out — the walls, not the flight, carry that beat.               */
  /* The shaft is simply on for the whole passage. It empties out on
     its own as we travel, so there is nothing to fade — only the very
     end, once the mark is back and the lockup takes over.           */
  var WALL_KEYS = [
    { t: 9.90, v: 0 }, { t: 10.45, v: 1 }, { t: 20.55, v: 1 }, { t: 20.70, v: 0 }
  ];
  function envAt(keys, t) {
    if (t <= keys[0].t) return keys[0].v;
    var last = keys[keys.length - 1];
    if (t >= last.t) return last.v;
    for (var i = 0; i < keys.length - 1; i++) {
      var k0 = keys[i], k1 = keys[i + 1];
      if (t <= k1.t) {
        var e = k1.e || smooth;
        return lerp(k0.v, k1.v, e((t - k0.t) / (k1.t - k0.t)));
      }
    }
    return last.v;
  }
  function flightAt(t) { return envAt(FLIGHT_KEYS, t); }

  /* ============================================================
     04 · PATH PARSER — full SVG path grammar, converted to
     absolute commands and split at every subpath. Arc flags are
     read as single characters (the classic "00-.856" trap).
     ============================================================ */
  function parseSubpaths(d) {
    var i = 0, n = d.length;
    var cx = 0, cy = 0, sx = 0, sy = 0;      /* pen + subpath start          */
    var pcx = null, pcy = null;              /* prev cubic control (for S)   */
    var pqx = null, pqy = null;              /* prev quad control (for T)    */
    var cmd = null, prevCmd = null;
    var subs = [], cur = null;
    var guard = 0;

    function isCmdChar(c) { return /[MmLlHhVvCcSsQqTtAaZz]/.test(c); }
    function skipSep() { while (i < n && /[\s,]/.test(d[i])) i++; }
    function num() {
      skipSep();
      var s = i;
      if (d[i] === "+" || d[i] === "-") i++;
      while (i < n && /[0-9]/.test(d[i])) i++;
      if (d[i] === ".") { i++; while (i < n && /[0-9]/.test(d[i])) i++; }
      if (d[i] === "e" || d[i] === "E") {
        i++;
        if (d[i] === "+" || d[i] === "-") i++;
        while (i < n && /[0-9]/.test(d[i])) i++;
      }
      if (s === i) throw new Error("path: expected number at " + i);
      return parseFloat(d.slice(s, i));
    }
    function flag() {
      skipSep();
      var c = d[i];
      if (c !== "0" && c !== "1") throw new Error("path: bad arc flag at " + i);
      i++;
      return c === "1" ? 1 : 0;
    }
    function fmt(v) { return String(Math.round(v * 1e4) / 1e4); }
    function emit(s) { cur.d += s; }
    function dropCtrls() { pcx = pcy = pqx = pqy = null; }

    while (true) {
      if (++guard > 100000) throw new Error("path: parser guard tripped");
      skipSep();
      if (i >= n) break;
      var c = d[i];
      if (isCmdChar(c)) { cmd = c; i++; }
      else if (!/[0-9+.\-]/.test(c)) throw new Error("path: unexpected '" + c + "' at " + i);
      else if (cmd === null || cmd === "Z" || cmd === "z")
        throw new Error("path: numbers with no command at " + i);

      switch (cmd) {
        case "M": case "m": {
          var mx = num(), my = num();
          if (cmd === "m" && subs.length > 0) { mx += cx; my += cy; }
          cx = sx = mx; cy = sy = my;
          cur = { d: "M" + fmt(mx) + " " + fmt(my) };
          subs.push(cur);
          dropCtrls();
          cmd = (cmd === "m") ? "l" : "L";    /* implicit pairs become linetos */
          break;
        }
        case "L": case "l": {
          var lx = num(), ly = num();
          if (cmd === "l") { lx += cx; ly += cy; }
          cx = lx; cy = ly;
          emit("L" + fmt(lx) + " " + fmt(ly));
          dropCtrls();
          break;
        }
        case "H": case "h": {
          var hx = num();
          if (cmd === "h") hx += cx;
          cx = hx;
          emit("L" + fmt(hx) + " " + fmt(cy));
          dropCtrls();
          break;
        }
        case "V": case "v": {
          var vy = num();
          if (cmd === "v") vy += cy;
          cy = vy;
          emit("L" + fmt(cx) + " " + fmt(vy));
          dropCtrls();
          break;
        }
        case "C": case "c": {
          var c1x = num(), c1y = num(), c2x = num(), c2y = num(), cex = num(), cey = num();
          if (cmd === "c") { c1x += cx; c1y += cy; c2x += cx; c2y += cy; cex += cx; cey += cy; }
          emit("C" + fmt(c1x) + " " + fmt(c1y) + " " + fmt(c2x) + " " + fmt(c2y) +
               " " + fmt(cex) + " " + fmt(cey));
          pcx = c2x; pcy = c2y; pqx = pqy = null;
          cx = cex; cy = cey;
          break;
        }
        case "S": case "s": {
          var s2x = num(), s2y = num(), sex = num(), sey = num();
          if (cmd === "s") { s2x += cx; s2y += cy; sex += cx; sey += cy; }
          var r1x = (pcx !== null) ? 2 * cx - pcx : cx;
          var r1y = (pcy !== null) ? 2 * cy - pcy : cy;
          emit("C" + fmt(r1x) + " " + fmt(r1y) + " " + fmt(s2x) + " " + fmt(s2y) +
               " " + fmt(sex) + " " + fmt(sey));
          pcx = s2x; pcy = s2y; pqx = pqy = null;
          cx = sex; cy = sey;
          break;
        }
        case "Q": case "q": {
          var q1x = num(), q1y = num(), qex = num(), qey = num();
          if (cmd === "q") { q1x += cx; q1y += cy; qex += cx; qey += cy; }
          emit("Q" + fmt(q1x) + " " + fmt(q1y) + " " + fmt(qex) + " " + fmt(qey));
          pqx = q1x; pqy = q1y; pcx = pcy = null;
          cx = qex; cy = qey;
          break;
        }
        case "T": case "t": {
          var tex = num(), tey = num();
          if (cmd === "t") { tex += cx; tey += cy; }
          var rqx = (pqx !== null) ? 2 * cx - pqx : cx;
          var rqy = (pqy !== null) ? 2 * cy - pqy : cy;
          emit("Q" + fmt(rqx) + " " + fmt(rqy) + " " + fmt(tex) + " " + fmt(tey));
          pqx = rqx; pqy = rqy; pcx = pcy = null;
          cx = tex; cy = tey;
          break;
        }
        case "A": case "a": {
          var rx = num(), ry = num(), rot = num(), laf = flag(), swf = flag();
          var aex = num(), aey = num();
          if (cmd === "a") { aex += cx; aey += cy; }
          emit("A" + fmt(rx) + " " + fmt(ry) + " " + fmt(rot) + " " + laf + " " + swf +
               " " + fmt(aex) + " " + fmt(aey));
          dropCtrls();
          cx = aex; cy = aey;
          break;
        }
        case "Z": case "z": {
          emit("Z");
          cx = sx; cy = sy;
          dropCtrls();
          break;
        }
      }
      prevCmd = cmd;
    }
    return subs.map(function (s) { return s.d; });
  }

  /* ============================================================
     05 · SCENE BUILD — layered SVG. Bottom to top:
     fill body · ghost skeleton · chase · one blurred bloom group
     (glow bed + flash + comet halos + tip halos) · main strokes ·
     comets · crisp tips · completion flares.
     ============================================================ */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var stage = document.getElementById("stage");

  function make(tag, attrs, parent) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  /* The far face and the walls and the tunnel, all on one canvas
     behind the stage; the word rides on a second canvas in front. */
  var bodyCv = document.createElement("canvas");
  bodyCv.className = "body";
  bodyCv.setAttribute("aria-hidden", "true");
  document.body.appendChild(bodyCv);
  var bctx = bodyCv.getContext("2d");

  var foreCv = document.createElement("canvas");
  foreCv.className = "fore";
  foreCv.setAttribute("aria-hidden", "true");
  document.body.appendChild(foreCv);
  var fctx = foreCv.getContext("2d");

  var deck = document.createElement("div");
  deck.className = "deck";
  stage.appendChild(deck);

  var svg = make("svg", { viewBox: "-2.5 -2.5 29 29", role: "img" }, deck);
  svg.setAttribute("aria-label", "ChatGPT logo drawn as animated line art");

  var defs = make("defs", {}, svg);
  var bloomFilter = make("filter", {
    id: "bloom", x: "-25%", y: "-25%", width: "150%", height: "150%"
  }, defs);
  make("feGaussianBlur", { stdDeviation: "0.45" }, bloomFilter);

  var rig = make("g", {}, svg);

  var occluder   = make("path", { "class": "occluder", d: "" }, rig);
  var fillBody   = make("path", { "class": "fillbody", d: "" }, rig);
  var gGhost     = make("g", {}, rig);
  var gChase     = make("g", { "class": "layer-chase" }, rig);
  var gBloom     = make("g", { "class": "layer-bloom", filter: "url(#bloom)" }, rig);
  var gMain      = make("g", {}, rig);
  var gComet     = make("g", { "class": "layer-comet" }, rig);
  var gTips      = make("g", {}, rig);
  var gFlares    = make("g", {}, rig);

  /* ============================================================
     06 · MEASURE & CAST — parse, measure, then assign each
     subpath its role and its place in the drawing order.
     ============================================================ */
  var subD;
  try {
    subD = parseSubpaths(SOURCE_D);
    if (subD.length < 2) throw new Error("path: expected multiple subpaths");
  } catch (err) {
    /* If the parser ever fails, never show a blank stage —
       fall back to the plain filled mark.                    */
    fillBody.setAttribute("d", SOURCE_D);
    fillBody.style.opacity = "1";
    return;
  }
  fillBody.setAttribute("d", subD.join(""));
  fillBody.style.opacity = "0";
  occluder.setAttribute("d", subD.join(""));
  occluder.style.opacity = "0";

  /* ============================================================
     06a · THE SOLID — the outlines swept back into real geometry.
     Every wall is a quad between the front contour and the back
     contour, projected through the same perspective the CSS uses
     for the face, then lit and depth-sorted. One continuous
     surface: no stacking, no seams, correct at any angle.
     ============================================================ */
  /* Sample every contour once, at even arc length. */
  var contours = (function () {
    var tmp = make("path", {}, gGhost);
    var out = subD.map(function (dStr) {
      tmp.setAttribute("d", dStr);
      var L = tmp.getTotalLength();
      var n = Math.max(24, Math.round(L / 0.34));   /* ≈6px segments at 520px */
      var xs = new Float64Array(n), ys = new Float64Array(n);
      for (var i = 0; i < n; i++) {
        var p = tmp.getPointAtLength(L * i / n);
        xs[i] = p.x; ys[i] = p.y;
      }
      return {
        n: n, xs: xs, ys: ys,
        fx: new Float64Array(n), fy: new Float64Array(n), fz: new Float64Array(n),
        bx: new Float64Array(n), by: new Float64Array(n), bz: new Float64Array(n)
      };
    });
    gGhost.removeChild(tmp);
    return out;
  })();
  /* Which contour is the hexagon? Not the outer ring — that circles
     the centre too. Drop the longest contour first, then take the
     one hugging the middle. It becomes the mouth of the tunnel,
     and its six corners sit at even sixths of its length.        */
  var hexIdx = 0;
  (function () {
    var longest = 0;
    contours.forEach(function (c, ci) {
      if (c.n > contours[longest].n) longest = ci;
    });
    var best = Infinity;
    contours.forEach(function (c, ci) {
      if (ci === longest) return;
      var sx = 0, sy = 0;
      for (var i = 0; i < c.n; i++) { sx += c.xs[i]; sy += c.ys[i]; }
      var d = Math.hypot(sx / c.n - CX, sy / c.n - CY);
      if (d < best) { best = d; hexIdx = ci; }
    });
  })();
  /* The six corners are local turn-angle maxima, not even sixths of the
     arc length — this hexagon's edges differ in length and the sample
     grid quantises further, which would tilt the shaft off its own
     axis of symmetry. Take the sharpest turns instead.               */
  var hexCorners = (function () {
    var c = contours[hexIdx], n = c.n, i, j;
    var turn = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var p = (i + n - 1) % n, q = (i + 1) % n;
      var ax = c.xs[i] - c.xs[p], ay = c.ys[i] - c.ys[p];
      var bx = c.xs[q] - c.xs[i], by = c.ys[q] - c.ys[i];
      turn[i] = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    }
    var ord = [], picks = [];
    for (i = 0; i < n; i++) ord.push(i);
    ord.sort(function (a, b) { return turn[b] - turn[a]; });
    for (i = 0; i < ord.length && picks.length < 6; i++) {
      var k = ord[i], far = true;
      for (j = 0; j < picks.length; j++) {
        var d = Math.abs(picks[j] - k);
        if (Math.min(d, n - d) < n / 12) { far = false; break; }
      }
      if (far) picks.push(k);
    }
    picks.sort(function (a, b) { return a - b; });
    /* the sample nearest a corner is not the corner; recover it exactly
       by intersecting the straight run on either side                 */
    return picks.map(function (k) {
      function at(o) { var m = ((k + o) % n + n) % n; return [c.xs[m], c.ys[m]]; }
      var a1 = at(-6), a2 = at(-3), b1 = at(3), b2 = at(6);
      var d1x = a2[0] - a1[0], d1y = a2[1] - a1[1];
      var d2x = b2[0] - b1[0], d2y = b2[1] - b1[1];
      var den = d1x * d2y - d1y * d2x;
      if (Math.abs(den) < 1e-9) return [c.xs[k], c.ys[k]];
      var s = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / den;
      return [a1[0] + d1x * s, a1[1] + d1y * s];
    });
  })();

  /* The wordmark is real outline art, so it is filled straight from
     its own path rather than sampled and stroked. */
  var wordPath = new Path2D(WORD_D);

  var QN = contours.reduce(function (s, c) { return s + c.n; }, 0);
  var qDepth = new Float64Array(QN);
  var qTone  = new Int32Array(QN);
  var qRef   = new Int32Array(QN * 2);      /* contour index, edge index */
  var qOrder = new Int32Array(QN);

  var TONES = 15;
  var toneRgb = [];
  function hexToRgb(s) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((s || "").trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16)];
  }
  function buildTones() {
    var cs = getComputedStyle(document.documentElement);
    var ink = hexToRgb(cs.getPropertyValue("--ink")) || [244, 245, 247];
    var bg  = hexToRgb(cs.getPropertyValue("--bg"))  || [8, 8, 11];
    toneRgb = [];
    for (var i = 0; i < TONES; i++) {
      var k = 0.03 + 0.42 * Math.pow(i / (TONES - 1), 0.9);
      toneRgb.push("rgb(" +
        Math.round(bg[0] + (ink[0] - bg[0]) * k) + "," +
        Math.round(bg[1] + (ink[1] - bg[1]) * k) + "," +
        Math.round(bg[2] + (ink[2] - bg[2]) * k) + ")");
    }
    inkRgb = ink;
    bgRgb = bg;
    bgCss = "rgb(" + bg[0] + "," + bg[1] + "," + bg[2] + ")";
  }
  var inkRgb = [244, 245, 247], bgRgb = [8, 8, 11], bgCss = "rgb(8,8,11)";
  function inkA(a) {
    return "rgba(" + inkRgb[0] + "," + inkRgb[1] + "," + inkRgb[2] + "," + a + ")";
  }
  /* an opaque blend of ground and ink — surfaces, not glazes */
  function mixInk(k) {
    if (k < 0) k = 0; else if (k > 1) k = 1;
    return "rgb(" +
      Math.round(bgRgb[0] + (inkRgb[0] - bgRgb[0]) * k) + "," +
      Math.round(bgRgb[1] + (inkRgb[1] - bgRgb[1]) * k) + "," +
      Math.round(bgRgb[2] + (inkRgb[2] - bgRgb[2]) * k) + ")";
  }
  buildTones();
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", buildTones);
  new MutationObserver(buildTones).observe(document.documentElement,
    { attributes: true, attributeFilter: ["data-theme"] });

  var PERSP = 1500;                          /* must match the CSS perspective */
  var NEAR_Z = PERSP - 95;                   /* anything past this is behind us */
  var stageW = 620, dpr = 1, depthPx = 70;
  var viewW = 800, viewH = 800, cx0 = 400, cy0 = 400, unit = 21.4;
  function layoutBody() {
    stageW = stage.clientWidth || 620;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    depthPx = stageW * CFG.ext.depth;
    unit = stageW / 29;
    viewW = window.innerWidth || document.documentElement.clientWidth || 900;
    viewH = window.innerHeight || document.documentElement.clientHeight || 900;
    var r = stage.getBoundingClientRect();
    cx0 = (r.width ? r.left + r.width / 2 : viewW / 2);   /* the mark's centre */
    cy0 = (r.height ? r.top + r.height / 2 : viewH / 2);
    [bodyCv, foreCv].forEach(function (cv) {
      var w = Math.max(1, Math.round(viewW * dpr));
      var h = Math.max(1, Math.round(viewH * dpr));
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
    });
  }
  /* the stage can settle after first paint — keep the canvases honest */
  function syncLayout() {
    var w = window.innerWidth || document.documentElement.clientWidth || 900;
    var h = window.innerHeight || document.documentElement.clientHeight || 900;
    if (w !== viewW || h !== viewH || stage.clientWidth !== stageW ||
        bodyCv.width < 2) layoutBody();
  }
  layoutBody();
  if (window.ResizeObserver) new ResizeObserver(layoutBody).observe(stage);
  window.addEventListener("resize", layoutBody);

  /* Light sitting up and to the left, in front of the object. */
  var LX = -0.52, LY = -0.42, LZ = 0.74;

  /* One shared world transform. Local points are in px around the
     mark's centre; z is the mark's own depth axis. The matrix is
     built exactly like the CSS chain the drawn face uses, so the
     canvas and the DOM agree to the pixel:

        translate3d(0, lockY, flight) · scale(s) · rotX · rotY · rotZ

     scale() is 2-D in CSS — it leaves z alone — so only the first
     two rows carry it.                                            */
  var W = {
    m00: 1, m01: 0, m02: 0,
    m10: 0, m11: 1, m12: 0,
    m20: 0, m21: 0, m22: 1,
    tx: 0, ty: 0, tz: 0
  };
  function setWorld(rxDeg, ryDeg, rzDeg, s, lockX, lockY, flight) {
    var ca = Math.cos(rxDeg * Math.PI / 180), sa = Math.sin(rxDeg * Math.PI / 180);
    var cb = Math.cos(ryDeg * Math.PI / 180), sb = Math.sin(ryDeg * Math.PI / 180);
    var cg = Math.cos(rzDeg * Math.PI / 180), sg = Math.sin(rzDeg * Math.PI / 180);
    W.m00 = s * (cb * cg);                 W.m01 = s * (-cb * sg);                W.m02 = s * sb;
    W.m10 = s * (ca * sg + sa * sb * cg);  W.m11 = s * (ca * cg - sa * sb * sg);  W.m12 = s * (-sa * cb);
    W.m20 = sa * sg - ca * sb * cg;        W.m21 = sa * cg + ca * sb * sg;        W.m22 = ca * cb;
    W.tx = lockX;
    W.ty = lockY;
    W.tz = flight;
  }
  /* world → screen, writing into a 3-slot scratch */
  var _p = [0, 0, 0];
  function project(x, y, z) {
    var X = W.m00 * x + W.m01 * y + W.m02 * z + W.tx;
    var Y = W.m10 * x + W.m11 * y + W.m12 * z + W.ty;
    var Z = W.m20 * x + W.m21 * y + W.m22 * z + W.tz;
    var f = PERSP / (PERSP - Z);
    _p[0] = cx0 + X * f;
    _p[1] = cy0 + Y * f;
    _p[2] = Z;
    return _p;
  }

  /* ---------- the solid: back face, then lit walls ---------- */
  function drawSolid(D, alpha) {
    if (D < 0.4 || alpha <= 0.004) return;
    var half = D / 2, ci, i;
    var qi = 0, anyNear = false;

    for (ci = 0; ci < contours.length; ci++) {
      var c = contours[ci];
      for (i = 0; i < c.n; i++) {
        var lx = (c.xs[i] - CX) * unit, ly = (c.ys[i] - CY) * unit;
        var p = project(lx, ly, half);
        c.fx[i] = p[0]; c.fy[i] = p[1]; c.fz[i] = p[2];
        p = project(lx, ly, -half);
        c.bx[i] = p[0]; c.by[i] = p[1]; c.bz[i] = p[2];
        if (c.fz[i] > NEAR_Z || c.bz[i] > NEAR_Z) anyNear = true;
      }
    }
    if (anyNear) return;                 /* we are inside it — let it go */

    bctx.globalAlpha = alpha;

    /* the far face, filled solid so the walls read as a closed body */
    var facingBack = W.m22 < 0;
    var facePath = new Path2D();
    for (ci = 0; ci < contours.length; ci++) {
      var cc = contours[ci];
      var useF = facingBack;             /* whichever plane points away */
      facePath.moveTo(useF ? cc.fx[0] : cc.bx[0], useF ? cc.fy[0] : cc.by[0]);
      for (i = 1; i < cc.n; i++) {
        facePath.lineTo(useF ? cc.fx[i] : cc.bx[i], useF ? cc.fy[i] : cc.by[i]);
      }
      facePath.closePath();
    }
    bctx.fillStyle = toneRgb[Math.round((TONES - 1) * 0.16)];
    bctx.fill(facePath);

    /* walls */
    for (ci = 0; ci < contours.length; ci++) {
      var c2 = contours[ci];
      for (i = 0; i < c2.n; i++) {
        var j = (i + 1) % c2.n;
        var ex = c2.xs[j] - c2.xs[i], ey = c2.ys[j] - c2.ys[i];
        /* out of the material, for every contour — so "inside" really
           picks the walls we cannot see and dims those instead        */
        var nx = -ey, ny = ex, nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        var wx = W.m00 * nx + W.m01 * ny, wy = W.m10 * nx + W.m11 * ny,
            wz = W.m20 * nx + W.m21 * ny;
        var wl = Math.hypot(wx, wy, wz) || 1;
        wx /= wl; wy /= wl; wz /= wl;
        var inside = wz < 0;
        if (inside) { wx = -wx; wy = -wy; wz = -wz; }
        var lam = wx * LX + wy * LY + wz * LZ;
        if (lam < 0) lam = 0;
        if (inside) lam *= 0.35;
        var tone = Math.round(lam * (TONES - 1));
        if (tone < 0) tone = 0;
        if (tone > TONES - 1) tone = TONES - 1;
        qTone[qi] = tone;
        qDepth[qi] = (c2.fz[i] + c2.fz[j] + c2.bz[i] + c2.bz[j]) * 0.25;
        qRef[qi * 2] = ci; qRef[qi * 2 + 1] = i;
        qOrder[qi] = qi;
        qi++;
      }
    }

    var ord = qOrder.subarray(0, qi);
    Array.prototype.sort.call(ord, function (a, b) { return qDepth[a] - qDepth[b]; });

    bctx.lineJoin = "round";
    bctx.lineWidth = 1;
    var path = null, tone2 = -1;
    for (i = 0; i < qi; i++) {
      var q = ord[i];
      if (qTone[q] !== tone2) {
        if (path) {
          bctx.fillStyle = bctx.strokeStyle = toneRgb[tone2];
          bctx.fill(path); bctx.stroke(path);
        }
        tone2 = qTone[q];
        path = new Path2D();
      }
      var c3 = contours[qRef[q * 2]], a2 = qRef[q * 2 + 1], b2 = (a2 + 1) % c3.n;
      path.moveTo(c3.fx[a2], c3.fy[a2]);
      path.lineTo(c3.fx[b2], c3.fy[b2]);
      path.lineTo(c3.bx[b2], c3.by[b2]);
      path.lineTo(c3.bx[a2], c3.by[a2]);
      path.closePath();
    }
    if (path) {
      bctx.fillStyle = bctx.strokeStyle = toneRgb[tone2];
      bctx.fill(path); bctx.stroke(path);
    }
    bctx.globalAlpha = 1;
  }

  /* The tunnel lies along the view axis, so it projects straight. */
  var _q = [0, 0];
  function projFlat(x, y, zw) {
    var f = PERSP / (PERSP - zw);
    _q[0] = cx0 + x * f;
    _q[1] = cy0 + y * f;
    return _q;
  }

  /* ---------- the shaft ----------
     The hexagon opened out into a tunnel. Its six inner faces are
     laid with tiles: each one shaded by the face it belongs to, by
     its distance, and by its own slight variation, with a hairline
     of dark between them. Far down the shaft the tiles stop coming
     — they drop out one by one, so the tunnel dissolves into a
     mosaic rather than ending.                                     */
  var SHAFT_NEAR = PERSP - 30;             /* clipped exactly at the eye  */
  var SHAFT_FALL = 13000;                  /* barely any — the tiles keep  */
  var TILE_LEN = 150;                      /* one course, in depth         */
  var TILE_COLS = 4;                       /* tiles across each face       */
  var TILE_MAXD = 4200;                    /* how far we bother drawing     */
  /* The mosaic thins out along the SHAFT, not with distance from the
     eye: the deeper the tunnel runs, the fewer tiles were ever laid.
     So the further we fly, the sparser it gets around us — and the
     view ahead is always the sparsest. It ends because it runs out,
     not because it dims.                                            */
  var TILE_D0 = 1400;                      /* depth where laying thins out  */
  var TILE_D1 = 7000;                      /* depth where the last one ends */
  var GROUT = 0.8;                         /* the dark line between tiles */

  /* Each face is lit by its own inward normal, so the shaft reads as
     a solid six-sided pipe rather than a flat vignette. */
  var shaftShade = (function () {
    var out = [];
    for (var e = 0; e < 6; e++) {
      var a = hexCorners[e], b = hexCorners[(e + 1) % 6];
      var mx = (a[0] + b[0]) / 2 - CX, my = (a[1] + b[1]) / 2 - CY;
      var l = Math.hypot(mx, my) || 1;
      var lam = (-mx / l) * LX + (-my / l) * LY;   /* normal points inward */
      out.push(0.30 + 0.70 * Math.max(0, lam));
    }
    return out;
  })();

  /* the ring of tile corners around the shaft, in local px */
  var perim = (function () {
    var out = [];
    for (var e = 0; e < 6; e++) {
      var a = hexCorners[e], b = hexCorners[(e + 1) % 6];
      for (var m = 0; m < TILE_COLS; m++) {
        var u = m / TILE_COLS;
        out.push([((a[0] + (b[0] - a[0]) * u) - CX) * unit,
                  ((a[1] + (b[1] - a[1]) * u) - CY) * unit]);
      }
    }
    return out;
  })();
  var PN = perim.length;
  function rebuildPerim() {
    for (var e = 0, i = 0; e < 6; e++) {
      var a = hexCorners[e], b = hexCorners[(e + 1) % 6];
      for (var m = 0; m < TILE_COLS; m++, i++) {
        var u = m / TILE_COLS;
        perim[i][0] = ((a[0] + (b[0] - a[0]) * u) - CX) * unit;
        perim[i][1] = ((a[1] + (b[1] - a[1]) * u) - CY) * unit;
      }
    }
  }

  var gx = [], gy = [];                    /* projected rows, reused */

  function drawShaft(flight, alpha) {
    if (alpha <= 0.004) return;
    rebuildPerim();

    /* floor, not ceil: the nearest course is allowed to sit past the eye
       and is clamped to the near plane, so the shaft always reaches the
       corners of the frame instead of leaving them black */
    var jMin = Math.max(0, Math.floor((flight - SHAFT_NEAR) / TILE_LEN));
    var jMax = Math.min(Math.floor((TILE_MAXD - PERSP + flight) / TILE_LEN),
                        Math.ceil(TILE_D1 / TILE_LEN));
    if (jMax <= jMin) return;
    var rows = jMax - jMin + 1;
    var j, i, r;

    /* every row is the same ring, scaled about the vanishing point */
    for (r = 0; r < rows; r++) {
      j = jMin + r;
      var z = Math.min(flight - j * TILE_LEN, SHAFT_NEAR);
      var f = PERSP / (PERSP - z);
      if (!gx[r]) { gx[r] = new Float64Array(PN); gy[r] = new Float64Array(PN); }
      for (i = 0; i < PN; i++) {
        gx[r][i] = cx0 + perim[i][0] * f;
        gy[r][i] = cy0 + perim[i][1] * f;
      }
    }

    bctx.globalAlpha = alpha;

    /* a near-black bed, so the grout reads as shadow and never as a
       hole through to the page behind */
    var bed = new Path2D();
    bed.moveTo(gx[0][0], gy[0][0]);
    for (i = 1; i < PN; i++) bed.lineTo(gx[0][i], gy[0][i]);
    bed.closePath();
    bed.moveTo(gx[rows - 1][0], gy[rows - 1][0]);
    for (i = 1; i < PN; i++) bed.lineTo(gx[rows - 1][i], gy[rows - 1][i]);
    bed.closePath();
    bctx.fillStyle = mixInk(0.035);
    bctx.fill(bed, "evenodd");

    /* the tiles, laid from the far end forward so nearer courses
       always overlap the ones behind them */
    for (r = rows - 2; r >= 0; r--) {
      j = jMin + r;
      var zN = Math.min(flight - j * TILE_LEN, SHAFT_NEAR);
      var dist = Math.max(1, PERSP - zN);
      if (dist > TILE_MAXD) continue;
      var fall = Math.exp(-dist / SHAFT_FALL);
      var depth = j * TILE_LEN;
      var diss = clamp01((depth - TILE_D0) / (TILE_D1 - TILE_D0));

      for (i = 0; i < PN; i++) {
        var i2 = (i + 1) % PN;
        var face = (i / TILE_COLS) | 0;
        var seed = j * 131 + i * 17;
        if (diss > 0 && h1(seed) < diss) continue;      /* this one has gone */

        /* the tile's own slight difference, so the wall reads as work
           rather than as paint */
        var vary = 0.78 + 0.44 * h1(seed + 7.3);
        var k = 0.50 * shaftShade[face] * fall * vary;

        var ax = gx[r][i], ay = gy[r][i];
        var bx = gx[r][i2], by = gy[r][i2];
        var cx2 = gx[r + 1][i2], cy2 = gy[r + 1][i2];
        var dx2 = gx[r + 1][i], dy2 = gy[r + 1][i];
        /* nothing on screen — most of a near course is off to the side */
        if ((ax < 0 && bx < 0 && cx2 < 0 && dx2 < 0) ||
            (ax > viewW && bx > viewW && cx2 > viewW && dx2 > viewW) ||
            (ay < 0 && by < 0 && cy2 < 0 && dy2 < 0) ||
            (ay > viewH && by > viewH && cy2 > viewH && dy2 > viewH)) continue;
        var mx = (ax + bx + cx2 + dx2) * 0.25;
        var my = (ay + by + cy2 + dy2) * 0.25;

        bctx.fillStyle = mixInk(k);
        bctx.beginPath();
        bctx.moveTo(mx + (ax - mx) * shrink(ax, ay, mx, my),
                    my + (ay - my) * shrink(ax, ay, mx, my));
        bctx.lineTo(mx + (bx - mx) * shrink(bx, by, mx, my),
                    my + (by - my) * shrink(bx, by, mx, my));
        bctx.lineTo(mx + (cx2 - mx) * shrink(cx2, cy2, mx, my),
                    my + (cy2 - my) * shrink(cx2, cy2, mx, my));
        bctx.lineTo(mx + (dx2 - mx) * shrink(dx2, dy2, mx, my),
                    my + (dy2 - my) * shrink(dx2, dy2, mx, my));
        bctx.closePath();
        bctx.fill();
      }
    }
    bctx.globalAlpha = 1;
  }

  /* a fixed hairline of grout, however large the tile is on screen */
  function shrink(px, py, mx, my) {
    var d = Math.hypot(px - mx, py - my);
    if (d < GROUT * 2) return 0.62;
    return (d - GROUT) / d;
  }

  /* ---------- the word, drawn flat and facing us ---------- */
  /* capPx is the cap height on screen — the one measurement the whole
     lockup is built from. Solid ink, no halo behind it.            */
  function drawWord(g, capPx, tx, ty, alpha) {
    if (alpha <= 0.004 || capPx <= 0.02) return;
    var s = capPx / WORD_CAP;
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = inkA(1);
    g.translate(cx0 + tx, cy0 + ty);
    g.scale(s, s);
    g.translate(-WORD_AX, -WORD_AY);
    g.fill(wordPath);
    g.restore();
  }

  /* ---------- the word as a solid ----------
     Same treatment the mark got: the letters are swept straight back
     from their own plane. Only this time the sweep has no end — it
     runs far enough that the far end is simply dark — and the walls
     are laid in the same tiles as the shaft, so travelling along them
     reads as speed rather than as a smooth blur.                     */
  var WORD_DEPTH = 46000;            /* local px: no end worth seeing  */
  var WCOURSE = 300;                 /* one course of wall tile        */
  var WTILE_MAXD = 6400;             /* past here, one dark tail quad  */

  /* Sample each letter's outline once, in path units. */
  var wordLetters = (function () {
    var tmp = make("path", {}, gGhost);
    var out = WORD_LETTERS.map(function (dStr) {
      var subs = parseSubpaths(dStr);
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      var contours = subs.map(function (sd) {
        tmp.setAttribute("d", sd);
        var L = tmp.getTotalLength();
        var n = Math.max(16, Math.round(L / 6.5));
        var xs = new Float64Array(n), ys = new Float64Array(n);
        for (var i = 0; i < n; i++) {
          var p = tmp.getPointAtLength(L * i / n);
          xs[i] = p.x; ys[i] = p.y;
          if (p.x < x0) x0 = p.x;
          if (p.x > x1) x1 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.y > y1) y1 = p.y;
        }
        return { n: n, xs: xs, ys: ys };
      });
      return {
        path: new Path2D(dStr), contours: contours,
        x0: x0, x1: x1, y0: y0, y1: y1,
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2
      };
    });
    gGhost.removeChild(tmp);
    return out;
  })();

  /* A transform of its own, built the same way the mark's is. */
  function wordMat(rxDeg, ryDeg, rzDeg, s, tx, ty, tz) {
    var ca = Math.cos(rxDeg * Math.PI / 180), sa = Math.sin(rxDeg * Math.PI / 180);
    var cb = Math.cos(ryDeg * Math.PI / 180), sb = Math.sin(ryDeg * Math.PI / 180);
    var cg = Math.cos(rzDeg * Math.PI / 180), sg = Math.sin(rzDeg * Math.PI / 180);
    return {
      m00: s * (cb * cg), m01: s * (-cb * sg), m02: s * sb,
      m10: s * (ca * sg + sa * sb * cg), m11: s * (ca * cg - sa * sb * sg),
      m12: s * (-sa * cb),
      m20: sa * sg - ca * sb * cg, m21: sa * cg + ca * sb * sg, m22: ca * cb,
      tx: tx, ty: ty, tz: tz
    };
  }
  var _wp = [0, 0, 0];
  function projW(M, x, y, z) {
    var X = M.m00 * x + M.m01 * y + M.m02 * z + M.tx;
    var Y = M.m10 * x + M.m11 * y + M.m12 * z + M.ty;
    var Z = M.m20 * x + M.m21 * y + M.m22 * z + M.tz;
    var f = PERSP / (PERSP - Z);
    _wp[0] = cx0 + X * f; _wp[1] = cy0 + Y * f; _wp[2] = Z;
    return _wp;
  }

  var wq = { x: new Float64Array(4), y: new Float64Array(4) };

  /* ---------- near-plane clipping ----------
     Once the eye is down among the geometry, faces routinely straddle
     the plane it sits on. Throwing those away leaves holes and makes
     things blink; projecting them anyway turns them inside out. So cut
     them along the plane first, then project what is left.          */
  var ZLIM = PERSP - 22;
  var _cx = new Float64Array(512), _cy = new Float64Array(512),
      _cz = new Float64Array(512), _out = new Float64Array(1200);
  function clipProject(n) {
    var cnt = 0, fLim = PERSP / (PERSP - ZLIM);
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var zi = _cz[i], zj = _cz[j];
      var ini = zi <= ZLIM, inj = zj <= ZLIM;
      if (ini) {
        var f = PERSP / (PERSP - zi);
        _out[cnt++] = cx0 + _cx[i] * f;
        _out[cnt++] = cy0 + _cy[i] * f;
      }
      if (ini !== inj) {
        var t = (ZLIM - zi) / (zj - zi);
        _out[cnt++] = cx0 + (_cx[i] + (_cx[j] - _cx[i]) * t) * fLim;
        _out[cnt++] = cy0 + (_cy[i] + (_cy[j] - _cy[i]) * t) * fLim;
      }
    }
    return cnt >> 1;
  }
  function worldInto(M, i, x, y, z) {
    _cx[i] = M.m00 * x + M.m01 * y + M.m02 * z + M.tx;
    _cy[i] = M.m10 * x + M.m11 * y + M.m12 * z + M.ty;
    _cz[i] = M.m20 * x + M.m21 * y + M.m22 * z + M.tz;
  }

  /* Draw the swept walls of every letter. capPx sets the letter size;
     the sweep runs along the letters' own -Z.                        */
  function drawWordSolid(M, capPx, alpha, lit, courseLen) {
    if (alpha <= 0.004) return;
    var k = capPx / WORD_CAP;
    var g = fctx;
    var CL = courseLen || WCOURSE;
    g.globalAlpha = alpha;

    for (var li = 0; li < wordLetters.length; li++) {
      var L = wordLetters[li];
      for (var ci = 0; ci < L.contours.length; ci++) {
        var C = L.contours[ci];
        for (var i = 0; i < C.n; i++) {
          var j = (i + 1) % C.n;
          var ax = (C.xs[i] - WORD_AX) * k, ay = (C.ys[i] - WORD_AY) * k;
          var bx = (C.xs[j] - WORD_AX) * k, by = (C.ys[j] - WORD_AY) * k;

          /* the wall's outward normal, for its share of the light */
          var ex = bx - ax, ey = by - ay;
          var nl = Math.hypot(ex, ey) || 1;
          var nx = -ey / nl, ny = ex / nl;
          var wx = M.m00 * nx + M.m01 * ny, wy = M.m10 * nx + M.m11 * ny,
              wz = M.m20 * nx + M.m21 * ny;
          var wl = Math.hypot(wx, wy, wz) || 1;
          wx /= wl; wy /= wl; wz /= wl;
          /* The solid is closed, so a wall turned away from the eye is
             hidden by the rest of it. Test against the line of sight to
             the wall itself — under perspective that is not the same as
             testing the normal's z, and with the word face-on it is the
             only test that culls anything at all.                     */
          var mxl = (ax + bx) * 0.5, myl = (ay + by) * 0.5;
          var pwx = M.m00 * mxl + M.m01 * myl + M.tx;
          var pwy = M.m10 * mxl + M.m11 * myl + M.ty;
          var pwz = M.m20 * mxl + M.m21 * myl + M.tz;
          if (wx * -pwx + wy * -pwy + wz * (PERSP - pwz) <= 0) continue;
          var lam = Math.max(0, wx * LX + wy * LY + wz * LZ);
          var shade = 0.18 + 0.82 * lam;

          /* near part in courses, so it streams when we move along it */
          var d = 0, course = 0;
          while (d < WTILE_MAXD && d < WORD_DEPTH) {
            var d2 = Math.min(d + CL, WORD_DEPTH);
            worldInto(M, 0, ax, ay, -d);
            worldInto(M, 1, bx, by, -d);
            worldInto(M, 2, bx, by, -d2);
            worldInto(M, 3, ax, ay, -d2);
            var zA = _cz[0], zB = _cz[3];
            d = d2; course++;
            if (_cz[0] > ZLIM && _cz[1] > ZLIM &&
                _cz[2] > ZLIM && _cz[3] > ZLIM) continue;
            /* cheap reject before the clip: a course wholly off one
               side of the frame cannot come back on after clipping */
            if (_cz[0] < ZLIM && _cz[1] < ZLIM &&
                _cz[2] < ZLIM && _cz[3] < ZLIM) {
              var f0 = PERSP / (PERSP - _cz[0]), f1 = PERSP / (PERSP - _cz[1]);
              var f2 = PERSP / (PERSP - _cz[2]), f3 = PERSP / (PERSP - _cz[3]);
              var sx0 = cx0 + _cx[0] * f0, sx1 = cx0 + _cx[1] * f1;
              var sx2 = cx0 + _cx[2] * f2, sx3 = cx0 + _cx[3] * f3;
              if ((sx0 < 0 && sx1 < 0 && sx2 < 0 && sx3 < 0) ||
                  (sx0 > viewW && sx1 > viewW && sx2 > viewW && sx3 > viewW))
                continue;
              var sy0 = cy0 + _cy[0] * f0, sy1 = cy0 + _cy[1] * f1;
              var sy2 = cy0 + _cy[2] * f2, sy3 = cy0 + _cy[3] * f3;
              if ((sy0 < 0 && sy1 < 0 && sy2 < 0 && sy3 < 0) ||
                  (sy0 > viewH && sy1 > viewH && sy2 > viewH && sy3 > viewH))
                continue;
            }
            var np = clipProject(4);
            if (np < 3) continue;

            var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, q;
            for (q = 0; q < np; q++) {
              var vx = _out[q * 2], vy = _out[q * 2 + 1];
              if (vx < minX) minX = vx;
              if (vx > maxX) maxX = vx;
              if (vy < minY) minY = vy;
              if (vy > maxY) maxY = vy;
            }
            /* slivers under a pixel cost as much as slabs and show
               nothing — a great many of them face us edge-on */
            if ((maxX - minX) * (maxY - minY) < 4) continue;
            if (maxX < 0 || minX > viewW || maxY < 0 || minY > viewH) continue;

            var dist = Math.max(1, PERSP - Math.min(zA, zB));
            var fall = Math.exp(-dist / 9000);
            var vary = 0.80 + 0.40 * h1(li * 53 + ci * 17 + i * 7 + course * 3);
            g.fillStyle = mixInk(lit * shade * fall * vary);
            g.beginPath();
            g.moveTo(_out[0], _out[1]);
            for (q = 1; q < np; q++) g.lineTo(_out[q * 2], _out[q * 2 + 1]);
            g.closePath();
            g.fill();
          }

          /* and one dark tail, so the sweep keeps going into nothing */
          if (WORD_DEPTH > WTILE_MAXD) {
            worldInto(M, 0, ax, ay, -WTILE_MAXD);
            worldInto(M, 1, bx, by, -WTILE_MAXD);
            worldInto(M, 2, bx, by, -WORD_DEPTH);
            worldInto(M, 3, ax, ay, -WORD_DEPTH);
            if (!(_cz[0] > ZLIM && _cz[1] > ZLIM &&
                  _cz[2] > ZLIM && _cz[3] > ZLIM)) {
              var nt = clipProject(4);
              if (nt >= 3) {
                var gd = g.createLinearGradient(
                  (_out[0] + _out[2]) / 2, (_out[1] + _out[3]) / 2,
                  (_out[(nt - 2) * 2] + _out[(nt - 1) * 2]) / 2,
                  (_out[(nt - 2) * 2 + 1] + _out[(nt - 1) * 2 + 1]) / 2);
                gd.addColorStop(0,
                  mixInk(lit * shade * Math.exp(-WTILE_MAXD / 9000)));
                gd.addColorStop(1, bgCss);
                g.fillStyle = gd;
                g.beginPath();
                g.moveTo(_out[0], _out[1]);
                for (var qt = 1; qt < nt; qt++) {
                  g.lineTo(_out[qt * 2], _out[qt * 2 + 1]);
                }
                g.closePath();
                g.fill();
              }
            }
          }
        }
      }
    }
    g.globalAlpha = 1;
  }

  /* The letters one at a time, so they can arrive separately. */
  function drawWordLetters(g, capPx, tx, ty, alpha, per) {
    if (alpha <= 0.004 || capPx <= 0.02) return;
    var s = capPx / WORD_CAP;
    for (var i = 0; i < wordLetters.length; i++) {
      var o = per(i);
      if (o.a <= 0.004) continue;
      g.save();
      g.globalAlpha = alpha * o.a;
      g.fillStyle = inkA(1);
      g.translate(cx0 + tx, cy0 + ty + o.dy);
      g.scale(s, s);
      g.translate(-WORD_AX, -WORD_AY);
      g.fill(wordLetters[i].path);
      g.restore();
    }
  }

  /* The lit face of the word, placed by the same transform. */
  function drawWordFace(M, capPx, alpha, apron, fogFromY, fogDist) {
    if (alpha <= 0.004) return;
    var k = capPx / WORD_CAP;
    /* Projected point by point rather than squeezed through one affine
       transform: a tilted plane is a homography, not an affine map, so
       the flat version had to be faded out before its error showed —
       this one stays right, and stays solid.                        */
    var g = fctx;
    g.globalAlpha = alpha;
    g.fillStyle = inkA(1);

    /* Running along the carried-on face, the surface must not simply
       stop, and it must not cross-fade as a whole either. It should go
       the way ground goes: thinning out ahead of you into the dark. So
       the fill takes a gradient down the road, and the point where it
       gives out is drawn towards us to end the shot.                */
    if (apron > 0 && fogDist > 0) {
      /* anchored on where we are, not on where the letter began — by
         now that is a long way behind us, and a gradient hung there
         projects back to front */
      var If = wordLetters[5];
      var fxc = (If.cx - WORD_AX) * k;
      var pA = projW(M, fxc, fogFromY - fogDist * 0.06, 0);
      var nx0 = pA[0], ny0 = pA[1];
      var pB = projW(M, fxc, fogFromY - fogDist, 0);
      var gd = g.createLinearGradient(nx0, ny0, pB[0], pB[1]);
      gd.addColorStop(0, inkA(1));
      gd.addColorStop(0.30, inkA(1));
      gd.addColorStop(0.68, inkA(0.5));
      gd.addColorStop(1, inkA(0));
      g.fillStyle = gd;
    }
    g.beginPath();
    var drew = false;
    for (var li = 0; li < wordLetters.length; li++) {
      var L = wordLetters[li];
      for (var ci = 0; ci < L.contours.length; ci++) {
        var C = L.contours[ci];
        if (C.n + 4 > _cx.length) continue;
        var behind = 0;
        for (var i = 0; i < C.n; i++) {
          worldInto(M, i, (C.xs[i] - WORD_AX) * k, (C.ys[i] - WORD_AY) * k, 0);
          if (_cz[i] > ZLIM) behind++;
        }
        if (behind === C.n) continue;         /* wholly past the eye */
        var np = clipProject(C.n);
        if (np < 3) continue;
        g.moveTo(_out[0], _out[1]);
        for (var q = 1; q < np; q++) g.lineTo(_out[q * 2], _out[q * 2 + 1]);
        g.closePath();
        drew = true;
      }
    }
    /* The last letter is barely longer than it is tall, and we are
       running down it. Carry its face on ahead of us so the surface
       has no end to reach — from this low the join cannot be seen. */
    if (apron > 0) {
      var Ia = wordLetters[5];
      var ax0 = (Ia.x0 - WORD_AX) * k, ax1 = (Ia.x1 - WORD_AX) * k;
      var ay0 = (Ia.y0 - WORD_AY) * k;
      worldInto(M, 0, ax0, ay0, 0);
      worldInto(M, 1, ax1, ay0, 0);
      worldInto(M, 2, ax1, ay0 - apron, 0);
      worldInto(M, 3, ax0, ay0 - apron, 0);
      if (!(_cz[0] > ZLIM && _cz[1] > ZLIM && _cz[2] > ZLIM && _cz[3] > ZLIM)) {
        var na = clipProject(4);
        if (na >= 3) {
          g.moveTo(_out[0], _out[1]);
          for (var qa = 1; qa < na; qa++) g.lineTo(_out[qa * 2], _out[qa * 2 + 1]);
          g.closePath();
          drew = true;
        }
      }
    }
    if (drew) g.fill("evenodd");
    g.globalAlpha = 1;
  }

  var cast = [];
  subD.forEach(function (dStr) {
    var probe = make("path", { d: dStr }, gGhost);   /* becomes the ghost */
    var L = probe.getTotalLength();
    var samples = [], sx = 0, sy = 0;
    var SAMPLE_N = 48;
    for (var j = 0; j < SAMPLE_N; j++) {
      var pt = probe.getPointAtLength(L * j / SAMPLE_N);
      samples.push({ x: pt.x, y: pt.y });
      sx += pt.x; sy += pt.y;
    }
    var cxm = sx / SAMPLE_N, cym = sy / SAMPLE_N;
    cast.push({
      d: dStr, L: L, ghost: probe,
      centX: cxm, centY: cym,
      centDist: Math.hypot(cxm - CX, cym - CY),
      phi: Math.atan2(cym - CY, cxm - CX),
      samples: samples
    });
  });

  /* Roles: the outer contour is by far the longest; the hexagon
     hugs the center. The six arms sort clockwise from 12 o'clock. */
  var outer = cast.reduce(function (a, b) { return b.L > a.L ? b : a; });
  var inner = cast.filter(function (a) { return a !== outer; });
  var hex = inner.reduce(function (a, b) { return b.centDist < a.centDist ? b : a; });
  var arms = inner.filter(function (a) { return a !== hex; });
  arms.sort(function (a, b) {
    var ka = (a.phi + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    var kb = (b.phi + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return ka - kb;
  });

  var ordered = [hex].concat(arms).concat([outer]);
  ordered.forEach(function (a, k) {
    a.k = k;
    a.isHex = (a === hex);
    a.isOuter = (a === outer);
    a.mode = (a.isHex || a.isOuter) ? "both" : "fwd";   /* two-ended vs pen   */
    if (a.isHex)        { a.t0 = CFG.draw.hexT0;   a.dur = CFG.draw.hexDur; }
    else if (a.isOuter) { a.t0 = CFG.draw.outerT0; a.dur = CFG.draw.outerDur; }
    else {
      a.t0 = CFG.draw.armT0 + (k - 1) * CFG.draw.armStagger;
      a.dur = CFG.draw.armDur;
    }
    a.end = a.t0 + a.dur;
  });

  /* Build the per-subpath layers. */
  ordered.forEach(function (a) {
    a.chase = make("path", { d: a.d, "stroke-width": CFG.w.chase }, gChase);
    a.glow  = make("path", { d: a.d, "stroke-width": CFG.w.glow  }, gBloom);
    a.flash = make("path", { d: a.d, "stroke-width": CFG.w.glow  }, gBloom);
    a.main  = make("path", { d: a.d, "stroke-width": CFG.w.main  }, gMain);
    a.ghost.setAttribute("stroke-width", CFG.w.ghost);
    a.ghost.style.opacity = "0";
    a.chase.style.opacity = "0";
    a.glow.style.opacity  = "0";
    a.flash.style.opacity = "0";
    a.main.style.opacity  = "0";
    a.flashMode = "off";
    a.drawCleared = false;

    /* Circulating comets: one per arm, a fast one on the hexagon,
       two counter-rotating on the outer contour. */
    var periods = a.isOuter ? CFG.cometPeriodsOuter : [CFG.cometPeriods[a.k % CFG.cometPeriods.length]];
    a.comets = periods.map(function (p, ci) {
      var halo = make("path", { d: a.d, "stroke-width": CFG.w.cometHalo }, gBloom);
      var el   = make("path", { d: a.d, "stroke-width": CFG.w.comet }, gComet);
      halo.style.opacity = "0";
      el.style.opacity = "0";
      return { el: el, halo: halo, period: Math.abs(p), dir: p < 0 ? -1 : 1,
               phase0: (a.k * 0.37 + ci * 0.5) % 1 };
    });

    /* Pen tips: a crisp core, a bloomed halo, a decaying trail.
       Two-ended strokes get a tip on each running end.          */
    var tipR = a.isOuter ? 0.19 : a.isHex ? 0.14 : 0.16;
    var nTips = (a.mode === "both") ? 2 : 1;
    a.tipR = tipR;
    a.tips = [];
    for (var ti = 0; ti < nTips; ti++) {
      var halo2 = make("circle", { r: tipR * 2.6, "class": "tip-dot" }, gBloom);
      var core  = make("circle", { r: tipR, "class": "tip-dot" }, gTips);
      halo2.style.opacity = "0";
      core.style.opacity = "0";
      var trail = [];
      for (var tj = 0; tj < 5; tj++) {
        var tc = make("circle", { r: tipR * (1 - (tj + 1) / 7), "class": "tip-dot" }, gTips);
        tc.style.opacity = "0";
        trail.push(tc);
      }
      /* embers: sparks the pen throws while it runs */
      var sparks = [];
      for (var sj = 0; sj < 3; sj++) {
        var sc = make("circle", { r: 0.05, "class": "tip-dot" }, gTips);
        sc.style.opacity = "0";
        sparks.push(sc);
      }
      a.tips.push({ core: core, halo: halo2, trail: trail, sparks: sparks });
    }

    /* Overture emissary — one per stroke, launched from the heart to
       this stroke's seam, where it waits as a beating seed of light. */
    a.seed = a.main.getPointAtLength(0);
    a.seedAng = Math.atan2(a.seed.y - CY, a.seed.x - CX);
    a.seedR = Math.hypot(a.seed.x - CX, a.seed.y - CY);
    var pHalo = make("circle", { r: 0.34, "class": "tip-dot" }, gBloom);
    var pCore = make("circle", { r: 0.13, "class": "tip-dot" }, gTips);
    pHalo.style.opacity = "0";
    pCore.style.opacity = "0";
    a.pt = { core: pCore, halo: pHalo };

    /* The emissary's tail: the spiral it flies is prebuilt as one
       path; three layered solid segments trail the head with soft
       taper — continuous light, never dots or dashes.            */
    var spiralPts = [];
    a.spiralLen = [0];
    for (var si = 0; si <= 48; si++) {
      var uu = si / 48;
      var ee = ease.outCubic(uu);
      var rr2 = a.seedR * (0.03 + 0.97 * ee);
      var aa2 = a.seedAng - (1 - ee) * CFG.ov.swing;
      var px2 = CX + Math.cos(aa2) * rr2, py2 = CY + Math.sin(aa2) * rr2;
      spiralPts.push([px2, py2]);
      if (si > 0) {
        var pv2 = spiralPts[si - 1];
        a.spiralLen.push(a.spiralLen[si - 1] +
          Math.hypot(px2 - pv2[0], py2 - pv2[1]));
      }
    }
    a.spiralTotal = a.spiralLen[48];
    var dSpiral = "M" + spiralPts.map(function (q) {
      return q[0].toFixed(3) + " " + q[1].toFixed(3);
    }).join("L");
    a.trail = [
      { el: make("path", { d: dSpiral, "stroke-width": 0.12 }, gTips), frac: 0.10, o: 0.50 },
      { el: make("path", { d: dSpiral, "stroke-width": 0.09 }, gTips), frac: 0.19, o: 0.28 },
      { el: make("path", { d: dSpiral, "stroke-width": 0.06 }, gTips), frac: 0.30, o: 0.14 }
    ];
    a.trail.forEach(function (tr) { tr.el.style.opacity = "0"; });
  });

  /* ACT 0 cast — just the heart light. No rings anywhere. */
  var heartHalo = make("circle", { cx: CX, cy: CY, r: 0.6, "class": "tip-dot" }, gBloom);
  var heart = make("circle", { cx: CX, cy: CY, r: 0.2, "class": "tip-dot" }, gTips);
  heart.style.opacity = "0";
  heartHalo.style.opacity = "0";

  var T_LOCK = CFG.ignite.t0 + CFG.ignite.sweep;

  /* ============================================================
     07 · TIMELINE HELPERS — deterministic: every value is a pure
     function of the master clock, so replay and rewind are free.
     ============================================================ */
  function dashFor(a, p) {
    /* "fwd": the pen runs the loop once around.
       "both": two ends grow from the seam and meet opposite it. */
    if (a.mode === "fwd") {
      return (a.L * p) + " " + (a.L * 4);
    }
    var hp = a.L * p / 2;
    return hp + " " + Math.max(0, a.L - 2 * hp) + " " + hp + " " + (a.L * 4);
  }

  function drawProgressAt(a, t) {
    return clamp01((t - a.t0) / a.dur);
  }

  function setTip(tip, x, y, o, rScale) {
    tip.core.setAttribute("cx", x); tip.core.setAttribute("cy", y);
    tip.halo.setAttribute("cx", x); tip.halo.setAttribute("cy", y);
    tip.core.style.opacity = o;
    tip.halo.style.opacity = o * 0.55;
    if (rScale) {
      tip.core.setAttribute("r", tip.core.__r0 * rScale);
    }
  }
  ordered.forEach(function (a) {
    a.tips.forEach(function (tip) { tip.core.__r0 = a.tipR; });
  });

  function hideTips(a) {
    a.tips.forEach(function (tip) {
      tip.core.style.opacity = "0";
      tip.halo.style.opacity = "0";
      tip.trail.forEach(function (tc) { tc.style.opacity = "0"; });
      if (tip.sparks) tip.sparks.forEach(function (sp) { sp.style.opacity = "0"; });
    });
  }

  /* Flash layer arbitration — exactly one effect owns it per frame. */
  function setFlashFull(a, opac) {
    if (a.flashMode !== "full") {
      a.flash.style.strokeDasharray = "";
      a.flash.style.strokeDashoffset = "";
      a.flashMode = "full";
    }
    a.flash.style.opacity = opac;
  }
  function setFlashWindow(a, winFrac, q, opac) {
    var w = a.L * winFrac;
    var o = w - (w + a.L) * q;           /* slides the window from −w to L   */
    if (a.flashMode !== "window") a.flashMode = "window";
    a.flash.style.strokeDasharray = w + " " + (a.L * 4);
    a.flash.style.strokeDashoffset = o;
    a.flash.style.opacity = opac;
  }
  function setFlashCentered(a, winFrac, centerLen, opac) {
    /* Pattern period exactly L (the comet idiom), so the window wraps
       the closed path's seam seamlessly instead of clipping there.   */
    var w = a.L * winFrac;
    if (a.flashMode !== "window") a.flashMode = "window";
    a.flash.style.strokeDasharray = w + " " + (a.L - w);
    a.flash.style.strokeDashoffset = (w / 2 - centerLen);
    a.flash.style.opacity = opac;
  }
  function setFlashOff(a) {
    if (a.flashMode !== "off") {
      a.flash.style.strokeDasharray = "";
      a.flash.style.strokeDashoffset = "";
      a.flashMode = "off";
    }
    a.flash.style.opacity = "0";
  }

  /* Map a sweep angle to a length along the outer contour, with
     linear interpolation between samples so the window travels
     smoothly instead of stepping in L/48 increments.             */
  var outerAngles = outer.samples.map(function (s) {
    return Math.atan2(s.y - CY, s.x - CX);
  });
  function outerLenAtAngle(theta) {
    var n = outerAngles.length, best = 0, bestD = Infinity;
    for (var j = 0; j < n; j++) {
      var d = Math.abs(angDiff(outerAngles[j], theta));
      if (d < bestD) { bestD = d; best = j; }
    }
    var next = (best + 1) % n, prev = (best + n - 1) % n;
    var dN = Math.abs(angDiff(outerAngles[next], theta));
    var dP = Math.abs(angDiff(outerAngles[prev], theta));
    var sign = dN <= dP ? 1 : -1;
    var dNb = Math.min(dN, dP);
    var f = (bestD + dNb) > 1e-6 ? bestD / (bestD + dNb) : 0;
    var idx = (best + sign * f + n) % n;
    return outer.L * idx / n;
  }

  /* ============================================================
     08 · POINTER PHYSICS — proximity springs per stroke, and a
     soft parallax on the whole rig. Fine pointers only.
     ============================================================ */
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var ptr = { x: 0, y: 0, has: false };
  var parX = { x: 0, v: 0 }, parY = { x: 0, v: 0 };

  ordered.forEach(function (a) { a.prox = { x: 0, v: 0 }; });

  function springTo(s, target, dt, K, C) {
    s.v += (K * (target - s.x) - C * s.v) * dt;
    s.x += s.v * dt;
  }

  if (finePointer) {
    window.addEventListener("pointermove", function (e) {
      ptr.x = e.clientX; ptr.y = e.clientY; ptr.has = true;
    }, { passive: true });
    document.documentElement.addEventListener("mouseleave", function () { ptr.has = false; });
    window.addEventListener("blur", function () { ptr.has = false; });
  }

  /* ============================================================
     09 · THE LOOP — one render pass, pure function of time.
     ============================================================ */
  var mode = "run";                     /* "run" | "rewind"                  */
  var t0 = performance.now();
  var rewindT0 = 0, rewindFrom = [], rewindTotal = 0, rewindBaseT = 0;
  var rewindFill = 0, rewindGhost = [], rewindCam0 = 1;
  var pendingRestart = 0;
  var lastNow = performance.now();
  var hiddenAt = null;
  var lastFacingBack = null;

  /* Camera position as a pure function of the master clock, so the
     rewind can glide from wherever it is to wherever it will restart. */
  function camAt(t) {
    return (t < CFG.cam.t0)
      ? CFG.cam.from
      : lerp(CFG.cam.from, 1, settleEase(clamp01((t - CFG.cam.t0) / CFG.cam.dur)));
  }

  function render(t, dt) {
    syncLayout();
    var amb = CFG.ambient.t0;
    /* tG keeps every oscillator phase-continuous across a rewind,
       so nothing visibly snaps when the piece unravels.          */
    var rq = (mode === "rewind") ? clamp01(t / rewindTotal) : 0;
    var tG = (mode === "rewind") ? rewindBaseT + t : t;
    var inAmbient = (mode === "run") && t >= amb;
    var ambEnv = smooth((tG - amb) / CFG.ambient.fadeIn) * (1 - smooth(rq));

    var ambientNow = tG >= amb;
    var flashFade = 1 - smooth(rq);

    /* ---- rig: overture dolly-in, then breath + sway + parallax ---- */
    var cam = (mode === "rewind")
      ? lerp(rewindCam0, camAt(pendingRestart), smooth(rq))
      : camAt(t);
    var breathe = 1 + 0.008 * Math.sin(tG * 0.85) * ambEnv;
    var sway = 1.0 * Math.sin(tG * 0.26 + 0.8) * ambEnv;
    var lockPulse = (tG > CFG.ignite.t0)
      ? gauss(tG - (T_LOCK + 0.05), 0.22) * flashFade : 0;
    var scale = cam * breathe * (1 + 0.012 * lockPulse);

    var ptTarget = { x: 0, y: 0 };
    if (finePointer && ptr.has && inAmbient && mode === "run") {
      ptTarget.x = (ptr.x / window.innerWidth) * 2 - 1;
      ptTarget.y = (ptr.y / window.innerHeight) * 2 - 1;
    }
    springTo(parX, ptTarget.x, dt, 40, 11);
    springTo(parY, ptTarget.y, dt, 40, 11);

    /* ================= THE PASSAGE =================
       One number drives the flight: how far we have travelled into
       the shaft, in pixels. The mark sits at flight, the eye is at
       PERSP, so flight ≈ 1500 puts the mark right at the eye.      */
    var flight = flightAt(tG) * flashFade;
    var wallVis = envAt(WALL_KEYS, tG) * flashFade;

    /* the solid's thickness, and its own turn */
    var D = depthPx * smooth((tG - CFG.ext.t0) / CFG.ext.dur) * flashFade;
    var bodyOn = smooth((tG - CFG.ext.t0) / 0.55) * flashFade;
    occluder.style.opacity = bodyOn;

    var u = clamp01((tG - CFG.spin.t0) / CFG.spin.dur);
    var idleEnv = smooth((tG - CFG.idle.t0) / CFG.idle.fadeIn);
    var ry = 360 * spinEase(u);                       /* slow, fast, hard stop */
    var rx = CFG.spin.rx * Math.sin(Math.PI * u);     /* dips out and back     */
    ry += CFG.idle.ry * Math.sin((tG - CFG.idle.t0) * CFG.idle.fy) * idleEnv;
    rx += CFG.idle.rx * Math.sin((tG - CFG.idle.t0) * CFG.idle.fx) * idleEnv;
    /* the pointer turns it a little; the springs are already pulled to
       zero on a replay, so let them ease out rather than cutting  */
    ry += 8 * parX.x * idleEnv;
    rx += -5 * parY.x * idleEnv;
    ry *= flashFade;
    rx *= flashFade;

    /* ---- the closing move: the word springs out to the right, the
       mark jumps back into the screen and swings left. Side by side,
       on one line — the lockup reads across, not down.          ---- */
    /* the lockup, every measure taken off the brand's own artwork and
       rebuilt from a single cap height */
    var capLock = LOCK_TOTAL * stageW / LOCK_SPAN;
    var markHLock = MARK_RATIO * capLock;
    var blockW = capLock * LOCK_SPAN;
    var markCxLock = -blockW / 2 + markHLock / 2;
    var wordCxLock = -blockW / 2 + markHLock + LOCK_GAP * capLock +
                     WORD_ASPECT * capLock / 2;
    var wordCyLock = -0.0179 * markHLock;    /* the brand's own offset */
    var fsLock = markHLock * 29 / (24 * stageW);

    /* the mark opens out of the middle: a speck at first, growing as
       its strokes come back, and only then does it move aside */
    var ju = clamp01((tG - CFG.jump.t0) / CFG.jump.dur) * flashFade;
    var lockScale = 1, lockX = 0;
    /* keyed on the clock, not on the eased value — at exactly ju = 0
       the test "ju > 0" fails and the mark blinks at full size */
    if (tG >= CFG.jump.t0 && flashFade > 0) {
      lockScale = lerp(CFG.jump.from * fsLock, fsLock, ease.outBack(ju));
      lockX = markCxLock * ease.outCubic(clamp01((ju - CFG.jump.hold) /
                                                 (1 - CFG.jump.hold)));
    }
    var faceScale = scale * lockScale;

    /* the drawn face fades as we pass through its own plane */
    /* The flight comes home behind the blackout, which would put the
       mark back on screen at full size a beat before it is due. It
       stays away until its own entrance.                            */
    var faceVis = 1 - smooth((flight - 500) / 800);
    if (tG > CFG.fade.t0 && tG < CFG.jump.t0) faceVis = 0;
    var pose = "translate3d(" + lockX + "px,0px," + flight + "px)" +
      " scale(" + faceScale + ")" +
      " rotateX(" + rx + "deg) rotateY(" + ry + "deg)" +
      " rotate(" + sway + "deg) translateZ(" + (D / 2) + "px)";
    deck.style.transform = pose;
    deck.style.opacity = faceVis;
    deck.style.visibility = faceVis < 0.01 ? "hidden" : "visible";

    /* ---- draw the canvases ---- */
    setWorld(rx, ry, sway, faceScale, lockX, 0, flight);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, viewW, viewH);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.clearRect(0, 0, viewW, viewH);

    if (wallVis > 0.004) drawShaft(flight, wallVis);
    drawSolid(D, bodyOn * faceVis);

    /* ---- the word ----
       It holds one size and travels right to left, so the O arrives
       first and the rest follows it into frame. Then it stops being a
       flat thing: it grows a depth that has no end, tips forward onto
       its face until it lies like ground, and the last letter becomes
       a road we run down.                                            */
    var wCap = 0, wX = 0, wY = 0, wA = 0;
    var capSlide = 0.74 * viewW / WORD_ASPECT;
    var capSeed = 0.012 * stageW;
    var xEnter = viewW / 2 + WORD_ASPECT * capSlide * 0.5 + 40;

    var solidOn = 0, wTilt = 0, wDepthOn = 0, wRun = 0, wRoadIn = 0;
    var wSolidCap = capSlide, wSX = 0, wSY = 0, wSZ = 0;

    if (tG >= CFG.word.slide0 && tG < CFG.deep.t0) {
      var su2 = wordEase(clamp01((tG - CFG.word.slide0) / CFG.word.slideDur));
      wCap = capSlide;
      wX = lerp(xEnter, 0, su2);
      wA = smooth((tG - CFG.word.slide0) / 0.25);
    /* runs through the fade, not up to it — cut at fade.t0 and the
       ground would simply cease instead of going out */
    } else if (tG >= CFG.deep.t0 && tG < CFG.fade.t0 + CFG.fade.dur) {
      /* from here the word is a body, not a drawing */
      wA = 0;
      solidOn = 1;
      wSolidCap = capSlide;
      wDepthOn = smooth((tG - CFG.deep.t0) / CFG.deep.dur);

      /* It tips forward — the feet of the letters lean towards us —
         and then, as we drop onto the last letter, it rights itself
         again so its shaft lines up with where we are looking. That
         is what turns a tilted slab into a road we can run down.   */
      var up = ease.inOutCubic(clamp01((tG - CFG.tilt2.t0) / CFG.tilt2.dur));
      wSolidCap = capSlide;

      /* Three separate moves, in order. First the camera slides
         sideways until it is in front of the last letter, and only
         sideways. Then it comes straight in until it is sitting just
         above that letter's face. Then it travels along the face
         itself, from below the letter up past its top — so we are on
         the surface looking up it, not burrowing into the material. */
      var lat = ease.inOutCubic(clamp01((tG - CFG.road.t0) / CFG.road.dur));
      var ap = ease.inOutCubic(clamp01((tG - CFG.near.t0) / CFG.near.dur));
      /* eases in, then holds its speed — a long run should not spend
         its whole length slowing down */
      var ru = runEase(clamp01((tG - CFG.run.t0) / CFG.run.dur));
      wRoadIn = Math.max(lat, ap);

      /* The eye cannot pitch, so for the face to behave as ground the
         ground must come level: the tip carries on past its dramatic
         angle until the surface lies flat and runs off to a vanishing
         point at eye height. The body below it drops out of sight —
         from up here there is only the surface.                     */
      wTilt = CFG.tilt2.deg * up + (CFG.near.flat - CFG.tilt2.deg) * ap;

      /* Sideways until we are in front of the last letter — and only
         sideways. Then down onto its face, skimming it: low enough
         that its far end sits all but on the horizon, which is what
         makes a letter barely a letter long read as a road without
         end. Then straight ahead across it.                        */
      var I = wordLetters[5];
      var kk = wSolidCap / WORD_CAP;
      var Ih = Math.max(1, (I.y1 - I.y0) * kk);
      var Iw = Math.max(1, (I.x1 - I.x0) * kk);

      var camLX = (I.cx - WORD_AX) * kk;
      /* out along the carried-on face, far past where the letter ends */
      var camLY = lerp((I.y1 - WORD_AY) * kk + Ih * CFG.near.below,
                       (I.y0 - WORD_AY) * kk - CFG.near.apron * kk * CFG.near.reach,
                       ru);
      var camLZ = CFG.near.high * Iw;        /* barely off the surface */

      var ta = wTilt * Math.PI / 180, ca2 = Math.cos(ta), sa2 = Math.sin(ta);
      var wX3 = camLX;
      var wY3 = camLY * ca2 - camLZ * sa2;
      var wZ3 = camLY * sa2 + camLZ * ca2;

      /* put the eye exactly there: sideways first, the rest after */
      wSX = -wX3 * lat;
      wSY = -wY3 * ap;
      wSZ = (PERSP - wZ3) * ap;
      wRun = ru;
    }

    /* the ground goes; the mark is already on its way in */
    var fadeOut = 1 - smooth((tG - CFG.fade.t0) / CFG.fade.dur);
    if (solidOn) {
      var M = wordMat(wTilt, 0, 0, 1, wSX, wSY, wSZ);
      /* courses only need to be fine once we are running along them */
      /* courses only need to be fine once we are running along them,
         and the walls want more light once they are all we can see */
      drawWordSolid(M, wSolidCap, fadeOut, 0.60 * wDepthOn * (1 + 2.1 * wRoadIn),
                    WCOURSE * (1 + 7 * (1 - wRoadIn * wRoadIn)));
      /* The face does not cross-fade — the road runs out ahead of us
         instead, and only what is left behind is taken by the alpha. */
      /* the road runs out ahead of us rather than dimming as a whole;
         the alpha only takes whatever is left over at the very end */
      var fogPull = smooth((tG - CFG.fade.t0) / CFG.fade.dur);
      /* eased in logarithmically, so the dissolve creeps up on you
         instead of snapping in over the last stretch */
      var fogDist = ap > 0.5
        ? Math.exp(lerp(Math.log(CFG.near.fog), Math.log(CFG.near.fogEnd),
                        ease.inOutCubic(fogPull))) * kk : 0;
      var faceA = ap > 0.5 ? (1 - smooth((tG - CFG.fade.t0 - 0.40) / 0.30))
                           : fadeOut;
      drawWordFace(M, wSolidCap, faceA, CFG.near.apron * kk * ap,
                   camLY, fogDist);
    }
    if (wA > 0.004) {
      drawWord(fctx, wCap * flashFade, wX * flashFade, wY * flashFade, wA);
    }

    /* ---- and the six letters drop into place beside the mark ---- */
    if (tG >= CFG.fall.t0 && flashFade > 0.004) {
      drawWordLetters(fctx, capLock * flashFade, wordCxLock * flashFade,
        wordCyLock * flashFade, 1, function (i) {
          var u = clamp01((tG - CFG.fall.t0 - i * CFG.fall.stagger) / CFG.fall.dur);
          if (u <= 0) return { dy: 0, a: 0 };
          return {
            dy: -CFG.fall.from * stageW * (1 - ease.outBack(u)),
            a: smooth(u * 5)
          };
        });
    }

    /* when the object has turned past its edge, the body leads */
    var facingBack = W.m22 < 0;
    if (facingBack !== lastFacingBack) {
      bodyCv.style.zIndex = facingBack ? "3" : "1";
      lastFacingBack = facingBack;
    }
    rig.style.opacity = (mode === "rewind") ? "1" : clamp01(t / 0.35);

    /* ---- pointer → per-stroke proximity targets. The stage box is
            untransformed, so this stays stable while the deck turns. */
    var pLocal = null;
    if (finePointer && ptr.has && inAmbient && mode === "run") {
      var rct = stage.getBoundingClientRect();
      if (rct.width > 0) {
        pLocal = {
          x: -2.5 + ((ptr.x - rct.left) / rct.width) * 29,
          y: -2.5 + ((ptr.y - rct.top) / rct.height) * 29
        };
      }
    }

    /* ---- ignition sweep state ---- */
    var uSweep = (t - CFG.ignite.t0) / CFG.ignite.sweep;
    var sweepActive = uSweep > 0 && uSweep < 1;
    var theta = -Math.PI / 2 + Math.PI * 2 * sweepEase(clamp01(uSweep));
    var sweepEnv = Math.pow(Math.sin(Math.PI * clamp01(uSweep)), 0.7);

    /* ---- shimmer + trace schedules (ambient; tG-continuous) ---- */
    var shimmerT0 = -1, traceT0 = -1, traceArm = -1;
    if (ambientNow) {
      var sInt = Math.floor((tG - amb - CFG.shimmer.first) / CFG.shimmer.every);
      if (sInt >= 0) shimmerT0 = amb + CFG.shimmer.first + sInt * CFG.shimmer.every;
      var trInt = Math.floor((tG - amb - CFG.trace.first) / CFG.trace.every);
      if (trInt >= 0) {
        traceT0 = amb + CFG.trace.first + trInt * CFG.trace.every;
        traceArm = (trInt * 5 + 2) % 7;          /* wanders the seven inner strokes */
      }
    }

    ordered.forEach(function (a, idx) {
      /* ---------- rewind override of draw progress ---------- */
      var p, uRaw;
      if (mode === "rewind") {
        var kRev = ordered.length - 1 - a.k;                /* last drawn retracts first */
        var rs = kRev * CFG.rewind.stagger;
        var ur = clamp01(((t) - rs) / CFG.rewind.each);     /* t is rewind-local here    */
        p = rewindFrom[idx] * (1 - ease.inOutQuad(ur));
        uRaw = p;
      } else if (t >= CFG.reveal2.t0) {
        /* the mark comes back the way it was born, but all at once:
           the core first, then all six arms together, then the ring */
        var r2 = CFG.reveal2;
        var at2 = r2.t0 + (a.isHex ? 0 : a.isOuter ? r2.ringLag : r2.armLag);
        uRaw = clamp01((t - at2) / r2.dur);
        p = drawEase(uRaw);
      } else {
        uRaw = drawProgressAt(a, t);
        p = drawEase(uRaw);
      }
      var drawing = p > 0.001 && uRaw < 1;   /* the tip runs out its own fade */
      var done = p >= 0.999;

      /* ---------- ghost skeleton — wakes as its emissary arrives ---------- */
      var arriveT = CFG.ov.burst + a.k * CFG.ov.flightStagger + CFG.ov.flight;
      var gIn = ease.outCubic(clamp01((t - arriveT) / 0.55));
      var gO = CFG.o.ghostIn * gIn;
      if (mode === "run" && t > CFG.ignite.t0) {
        gO = lerp(CFG.o.ghostIn, CFG.o.ghostRest, smooth((t - CFG.ignite.t0) / 0.8));
      }
      if (mode === "rewind") {
        /* glide from the captured level to exactly where the restart
           will pick it up — continuous at both ends of the unravel   */
        var gRestart = CFG.o.ghostIn *
          ease.outCubic(clamp01((pendingRestart - arriveT) / 0.55));
        gO = lerp(rewindGhost[idx] || 0, gRestart, smooth(rq));
      }
      a.ghost.style.opacity = gO;

      /* ---------- proximity spring ---------- */
      var proxTarget = 0;
      if (pLocal) {
        var best = Infinity;
        for (var j = 0; j < a.samples.length; j++) {
          var dxs = a.samples[j].x - pLocal.x, dys = a.samples[j].y - pLocal.y;
          var dd = dxs * dxs + dys * dys;
          if (dd < best) best = dd;
        }
        proxTarget = clamp01(1 - (Math.sqrt(best) - 0.35) / 2.2);
        proxTarget *= proxTarget;
      }
      springTo(a.prox, proxTarget, dt, 110, 21);
      var prox = Math.max(0, a.prox.x);   /* decays through a rewind, no snap */

      /* ---------- ignition flash intensity ---------- */
      var flashI = 0;
      if (mode === "run" && sweepActive && !a.isHex) {
        if (a.isOuter) flashI = 0.9 * sweepEnv;
        else flashI = 0.85 * gauss(angDiff(theta, a.phi), CFG.ignite.sigma) * sweepEnv;
      }
      var lockI = (mode === "run") ? (a.isHex ? 0.9 : 0.35) * lockPulse : 0;

      /* ---------- per-stroke breathing (registration-safe) ---------- */
      var brPhase = Math.sin(tG * 0.45 + a.k * 0.9);
      var brMain = 0.05 * brPhase * ambEnv;
      var brGlow = 0.03 * brPhase * ambEnv;

      /* ---------- main + chase + glow bed dashes ---------- */
      if (p <= 0.001) {
        a.main.style.opacity = "0";
        a.chase.style.opacity = "0";
        a.glow.style.opacity = "0";
        a.drawCleared = false;
      } else if (!done) {
        var dash = dashFor(a, p);
        a.main.style.strokeDasharray = dash;
        a.glow.style.strokeDasharray = dash;
        var pcRaw = (mode === "rewind")
          ? p
          : clamp01((t - a.t0 - CFG.draw.chaseLag) / a.dur);
        var pc = (mode === "rewind") ? p : drawEase(pcRaw);
        a.chase.style.strokeDasharray = dashFor(a, pc);
        a.main.style.opacity = CFG.o.main;
        a.chase.style.opacity = pc > 0.001 ? CFG.o.chaseDraw : "0";
        a.glow.style.opacity = 0.06;
        a.drawCleared = false;
      } else {
        if (!a.drawCleared) {
          a.main.style.strokeDasharray = "";
          a.chase.style.strokeDasharray = "";
          a.glow.style.strokeDasharray = "";
          a.drawCleared = true;
        }
        /* a landed stroke rests — no pulses on finished parts */
        a.main.style.opacity = Math.min(1, CFG.o.main + brMain + 0.1 * prox);
        a.chase.style.opacity = CFG.o.chaseRest + 0.02 * brPhase * ambEnv;
        a.glow.style.opacity = Math.min(0.8,
          CFG.o.glowBed + brGlow + 0.5 * prox + 0.55 * flashI + 0.5 * lockI);
      }
      a.main.style.strokeWidth =
        CFG.w.main * (1 + 0.55 * flashI + 0.45 * prox + 0.4 * lockI);

      /* ---------- pen tips ---------- */
      if (drawing) {
        var fadeIn = smooth(uRaw * 9);
        var fadeOut = 1 - smooth((uRaw - 0.94) / 0.06);
        /* on a replay the pen runs backwards down its own stroke and
           dims with it, rather than blinking out where it stood */
        var tipO = 0.95 * fadeIn * fadeOut * flashFade;
        var delta = Math.min(0.02 * a.L, 0.32);
        if (a.mode === "fwd") {
          var sLen = a.L * p;
          var tp = a.main.getPointAtLength(sLen);
          setTip(a.tips[0], tp.x, tp.y, tipO, 1);
          a.tips[0].trail.forEach(function (tc, tji) {
            var back = Math.max(0, sLen - (tji + 1) * delta);
            var bp = a.main.getPointAtLength(back);
            tc.setAttribute("cx", bp.x); tc.setAttribute("cy", bp.y);
            tc.style.opacity = tipO * 0.4 * (1 - (tji + 1) / 6);
          });
        } else {
          var hp = a.L * p / 2;
          var tpA = a.main.getPointAtLength(hp);
          var tpB = a.main.getPointAtLength(a.L - hp);
          setTip(a.tips[0], tpA.x, tpA.y, tipO, 1);
          setTip(a.tips[1], tpB.x, tpB.y, tipO, 1);
          a.tips.forEach(function (tip, side) {
            tip.trail.forEach(function (tc, tji) {
              var off = (tji + 1) * delta;
              var at = side === 0 ? Math.max(0, hp - off)
                                  : Math.min(a.L, a.L - hp + off);
              var bp = a.main.getPointAtLength(at);
              tc.setAttribute("cx", bp.x); tc.setAttribute("cy", bp.y);
              tc.style.opacity = tipO * 0.4 * (1 - (tji + 1) / 6);
            });
          });
        }

        /* ---------- embers thrown by the running pen ---------- */
        if (mode !== "run") {
          a.tips.forEach(function (tip) {
            tip.sparks.forEach(function (sp) { sp.style.opacity = "0"; });
          });
        } else
        a.tips.forEach(function (tip, side) {
          tip.sparks.forEach(function (sp, sj2) {
            var hs = a.k * 29 + side * 11 + sj2 * 7;
            var period = 0.34 + 0.3 * h1(hs);
            var cyc = Math.floor((t - a.t0) / period);
            var birth = a.t0 + cyc * period;
            var age = t - birth;
            var lifeU = age / CFG.embers.life;
            var pb = drawEase(clamp01((birth - a.t0) / a.dur));
            if (cyc >= 0 && lifeU < 1 && pb > 0.03 && pb < 0.985) {
              var sL2 = (a.mode === "fwd")
                ? a.L * pb
                : (side === 0 ? a.L * pb / 2 : a.L - a.L * pb / 2);
              var q0 = a.main.getPointAtLength(sL2);
              var q1 = a.main.getPointAtLength(Math.min(a.L, sL2 + 0.15));
              var tx2 = q1.x - q0.x, ty2 = q1.y - q0.y;
              var tl2 = Math.hypot(tx2, ty2) || 1;
              tx2 /= tl2; ty2 /= tl2;
              var sgn = h1(hs + cyc * 13) > 0.5 ? 1 : -1;
              var spd = 0.7 + 0.9 * h1(hs + cyc * 31);
              sp.setAttribute("cx", q0.x - ty2 * sgn * age * spd + tx2 * age * 0.35);
              sp.setAttribute("cy", q0.y + tx2 * sgn * age * spd + ty2 * age * 0.35);
              sp.setAttribute("r", Math.max(0.012, 0.055 * (1 - lifeU * 0.8)));
              sp.style.opacity = 0.7 * Math.pow(1 - lifeU, 1.6);
            } else {
              sp.style.opacity = "0";
            }
          });
        });
      } else {
        hideTips(a);
      }

      /* ---------- overture emissary: heart → seam ---------- */
      var pv = 0, ppx = a.seed.x, ppy = a.seed.y, uf = 1;
      if (mode === "rewind") {
        /* as the strokes unravel, the seeds re-light to catch them —
           unless the film restarts from the void (full replay)      */
        pv = (pendingRestart > 0.1)
          ? rq * (0.55 + 0.25 * Math.sin(tG * 6 + a.k * 1.3))
          : 0;
      } else if (t >= CFG.ov.burst && t < a.t0 + 0.2) {
        uf = clamp01((t - CFG.ov.burst - a.k * CFG.ov.flightStagger) / CFG.ov.flight);
        var eu = ease.outCubic(uf);
        var rr = a.seedR * (0.03 + 0.97 * eu);
        var aa = a.seedAng - (1 - eu) * CFG.ov.swing;
        ppx = CX + Math.cos(aa) * rr;
        ppy = CY + Math.sin(aa) * rr;
        var pulse2 = uf >= 1 ? (0.74 + 0.26 * Math.sin(t * 7 + a.k * 1.3)) : 1;
        pv = 0.92 * smooth(uf * 6) * clamp01(1 - (t - a.t0) / 0.15) * pulse2;
      }
      /* the touchdown: it lands hard, flares for a breath, settles */
      var land = (mode === "run") ? gauss(t - arriveT, 0.055) : 0;
      if (pv > 0.01) {
        var pr = 0.13 * (1 + 1.25 * land);
        a.pt.core.setAttribute("cx", ppx); a.pt.core.setAttribute("cy", ppy);
        a.pt.core.setAttribute("r", pr);
        a.pt.halo.setAttribute("cx", ppx); a.pt.halo.setAttribute("cy", ppy);
        a.pt.halo.setAttribute("r", pr * (2.6 + 2.4 * land));
        a.pt.core.style.opacity = Math.min(1, pv + 0.5 * land);
        a.pt.halo.style.opacity = pv * 0.55 + 0.35 * land;
      } else {
        a.pt.core.style.opacity = "0";
        a.pt.halo.style.opacity = "0";
      }

      /* ---------- solid tail chasing the spiral, fading on arrival ---------- */
      if (mode === "run" && t >= CFG.ov.burst && t < arriveT + 0.45) {
        var ufT = clamp01((t - CFG.ov.burst - a.k * CFG.ov.flightStagger) / CFG.ov.flight);
        var xL = ufT * 48, iL = Math.floor(xL), frL = xL - iL;
        var headLen = (iL >= 48) ? a.spiralTotal
          : a.spiralLen[iL] + (a.spiralLen[iL + 1] - a.spiralLen[iL]) * frL;
        var tEnv = smooth(ufT * 6) * (1 - smooth((t - arriveT) / 0.35));
        a.trail.forEach(function (tr) {
          var seg = Math.min(headLen, a.spiralTotal * tr.frac);
          if (seg < 0.02 || tEnv < 0.01) {
            tr.el.style.opacity = "0";
            return;
          }
          tr.el.style.strokeDasharray = seg + " " + (a.spiralTotal * 4);
          tr.el.style.strokeDashoffset = seg - headLen;
          tr.el.style.opacity = tr.o * tEnv;
        });
      } else {
        a.trail.forEach(function (tr) { tr.el.style.opacity = "0"; });
      }

      /* ---------- flash layer: ignition > trace > shimmer > off.
             Windows run on tG and fade with flashFade, so a rewind
             eases them out instead of hard-cutting them.           ---------- */
      if (sweepActive && a.isOuter) {
        setFlashCentered(a, 0.13, outerLenAtAngle(theta), 0.8 * sweepEnv);
      } else if (sweepActive && !a.isHex) {
        setFlashFull(a, flashI * 0.85);
      } else if (lockI > 0.02) {
        /* the sweep owned this layer until T_LOCK and handed it back at
           zero, so ease the lock flare up from there rather than letting
           the already-hot curve land as a cut                          */
        setFlashFull(a, lockI * 0.8 *
          (a.isHex ? 1 : smooth((t - T_LOCK) / 0.12)));
      } else if (ambientNow && !a.isOuter && a.k === traceArm && traceT0 > 0 &&
                 tG - traceT0 < CFG.trace.dur) {
        var qT = ease.inOutCubic(clamp01((tG - traceT0) / CFG.trace.dur));
        setFlashWindow(a, CFG.trace.frac, qT,
          CFG.trace.opac * flashFade *
          Math.sin(Math.PI * clamp01((tG - traceT0) / CFG.trace.dur)));
      } else if (ambientNow && shimmerT0 > 0 &&
                 tG - shimmerT0 - a.k * CFG.shimmer.armDelay < CFG.shimmer.dur &&
                 tG - shimmerT0 - a.k * CFG.shimmer.armDelay > 0) {
        var qs = ease.inOutSine(
          clamp01((tG - shimmerT0 - a.k * CFG.shimmer.armDelay) / CFG.shimmer.dur));
        setFlashWindow(a, CFG.shimmer.frac, qs,
          CFG.shimmer.opac * flashFade * Math.sin(Math.PI * qs));
      } else {
        setFlashOff(a);
      }

      /* ---------- comets: circulating light, ambient only ---------- */
      a.comets.forEach(function (cm) {
        if (!ambientNow) {
          cm.el.style.opacity = "0";
          cm.halo.style.opacity = "0";
          return;
        }
        /* tG keeps the comets circulating through a rewind while
           ambEnv (which carries 1 − smooth(rq)) breathes them out. */
        var frac = a.isOuter ? CFG.cometFracOuter : CFG.cometFracInner;
        var cLen = a.L * frac;
        var phase = ((tG / cm.period) * cm.dir + cm.phase0) % 1;
        if (phase < 0) phase += 1;
        var oDash = -phase * a.L;
        var breatheC = 0.75 + 0.25 * Math.sin(tG * 0.6 + a.k * 1.7);
        var cO = CFG.o.cometBase * ambEnv * breatheC * (1 + 0.5 * prox);
        cm.el.style.strokeDasharray = cLen + " " + (a.L - cLen);
        cm.el.style.strokeDashoffset = oDash;
        cm.el.style.opacity = Math.min(0.85, cO);
        cm.halo.style.strokeDasharray = cLen + " " + (a.L - cLen);
        cm.halo.style.strokeDashoffset = oDash;
        cm.halo.style.opacity = CFG.o.cometHalo * ambEnv * breatheC;
      });
    });

    /* ---------- the heart: out of pure darkness, a smooth swell,
           a breath in — and the burst. No wink, no rings.      ---------- */
    if (mode === "run" && t < CFG.draw.hexT0 + 0.4) {
      var appear = ease.outCubic(clamp01((t - CFG.ov.appearT0) / CFG.ov.appearDur));
      var squeeze = 1 - 0.18 * smooth((t - (CFG.ov.burst - 0.22)) / 0.22);
      var spend = 1 - smooth((t - CFG.ov.burst) / 0.3);
      var hr = 0.30 * appear * squeeze * spend;
      if (hr > 0.004) {
        heart.setAttribute("r", hr);
        heartHalo.setAttribute("r", hr * 3);
        heart.style.opacity = Math.min(1, 0.95 * appear * spend);
        heartHalo.style.opacity = Math.min(0.6, 0.5 * appear * spend);
      } else {
        heart.style.opacity = "0";
        heartHalo.style.opacity = "0";
      }
    } else {
      heart.style.opacity = "0";
      heartHalo.style.opacity = "0";
    }

    /* ---------- fill body ---------- */
    if (mode === "run") {
      fillBody.style.opacity = CFG.o.fill * smooth((t - T_LOCK) / 0.9);
    } else {
      /* fade from the level the fill actually had when the click came */
      fillBody.style.opacity = rewindFill * clamp01(1 - t * 3);
    }
  }

  /* Static final pose for reduced motion: everything landed, only a
     slow luminance breath remains — gentler, not zero.            */
  function renderStatic(now) {
    var breath = 0.5 + 0.5 * Math.sin(now / 1000 * 0.5);
    /* the finished lockup, held at a fixed three-quarter view */
    var capL = LOCK_TOTAL * stageW / LOCK_SPAN;
    var markHL = MARK_RATIO * capL;
    var blockL = capL * LOCK_SPAN;
    var lockX = -blockL / 2 + markHL / 2;
    var fs = markHL * 29 / (24 * stageW);
    deck.style.transform = "translate3d(" + lockX + "px,0px,0px) scale(" + fs +
      ") rotateX(6deg) rotateY(20deg) translateZ(" + (depthPx / 2) + "px)";
    deck.style.opacity = "1";
    deck.style.visibility = "visible";
    setWorld(6, 20, 0, fs, lockX, 0, 0);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, viewW, viewH);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.clearRect(0, 0, viewW, viewH);
    drawSolid(depthPx, 1);
    drawWord(fctx, capL,
      -blockL / 2 + markHL + LOCK_GAP * capL + WORD_ASPECT * capL / 2,
      -0.0179 * markHL, 1);
    occluder.style.opacity = "1";
    rig.style.opacity = "1";
    ordered.forEach(function (a) {
      a.ghost.style.opacity = CFG.o.ghostRest;
      a.main.style.strokeDasharray = "";
      a.chase.style.strokeDasharray = "";
      a.glow.style.strokeDasharray = "";
      a.main.style.strokeWidth = CFG.w.main;
      a.main.style.opacity = CFG.o.main;
      a.chase.style.opacity = CFG.o.chaseRest;
      a.glow.style.opacity = CFG.o.glowBed + 0.03 * breath;
      setFlashOff(a);
      hideTips(a);
      a.pt.core.style.opacity = "0";
      a.pt.halo.style.opacity = "0";
      a.trail.forEach(function (tr) { tr.el.style.opacity = "0"; });
      a.comets.forEach(function (cm) {
        cm.el.style.opacity = "0";
        cm.halo.style.opacity = "0";
      });
    });
    fillBody.style.opacity = CFG.o.fill;
    heart.style.opacity = "0";
    heartHalo.style.opacity = "0";
  }

  var SPEED = 1.0;
  var animFrameId = null;
  var isRunning = false;

  function stopLoop() {
    isRunning = false;
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  function startLoop() {
    if (!isRunning) {
      isRunning = true;
      lastNow = performance.now();
      animFrameId = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    if (!isRunning) return;
    try {
      var dt = Math.min(0.05, (now - lastNow) / 1000) * SPEED;
      lastNow = now;
      if (mode === "rewind") {
        var rt = ((now - rewindT0) / 1000) * SPEED;
        render(rt, dt);
        if (rt > rewindTotal) {
          mode = "run";
          t0 = now - (pendingRestart * 1000 / SPEED);
          pendingRestart = CFG.restartAt;
          ordered.forEach(function (a) { a.drawCleared = false; });
        }
      } else {
        var t = ((now - t0) / 1000) * SPEED;
        render(t, dt);
        /* Quand l'animation et sa transition finale sont terminées, on coupe la boucle pour libérer la RAM/CPU */
        if (t >= CFG.idle.t0 + CFG.idle.fadeIn && (!finePointer || !ptr.has)) {
          stopLoop();
          return;
        }
      }
    } catch (e) {
      /* never let an error kill the loop */
    }
    if (isRunning) {
      animFrameId = requestAnimationFrame(frame);
    }
  }

  /* ============================================================
     10 · REPLAY — one gesture, one meaning: the piece unravels
     in reverse, fast, then the whole film plays from the void.
     ============================================================ */
  function replay() {
    if (reduceMotion.matches || mode === "rewind") return;
    var t = (performance.now() - t0) / 1000;
    if (t < CFG.draw.hexT0 + 0.2) return;            /* nothing to unravel yet */
    pendingRestart = 0;
    rewindFrom = ordered.map(function (a) { return drawEase(drawProgressAt(a, t)); });
    rewindGhost = ordered.map(function (a) {
      return parseFloat(a.ghost.style.opacity) || 0;
    });
    rewindFill = CFG.o.fill * smooth((t - T_LOCK) / 0.9);
    rewindCam0 = camAt(t);
    rewindTotal = CFG.rewind.each + (ordered.length - 1) * CFG.rewind.stagger +
                  CFG.rewind.tail;
    rewindBaseT = t;
    rewindT0 = performance.now();
    ordered.forEach(function (a) { a.drawCleared = false; });
    mode = "rewind";
    startLoop();
  }

  window.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    replay();
  });
  window.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      replay();
    }
  });

  /* Pause the clock while hidden so the piece doesn't jump ahead. */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenAt = performance.now();
    } else if (hiddenAt !== null) {
      var away = performance.now() - hiddenAt;
      t0 += away;
      rewindT0 += away;
      lastNow = performance.now();
      hiddenAt = null;
    }
  });

  /* Headless test hook — only alive when the page is opened with ?probe. */
  if (location.search.indexOf("probe") !== -1) {
    window.__probe = {
      at: function (t) { render(t, 1 / 60); return "ok@" + t; },
      rewind: function (rt, base) {
        mode = "rewind";
        rewindFrom = ordered.map(function () { return 1; });
        rewindGhost = ordered.map(function () { return CFG.o.ghostRest; });
        rewindFill = CFG.o.fill;
        rewindCam0 = 1;
        rewindTotal = CFG.rewind.each + (ordered.length - 1) * CFG.rewind.stagger +
                  CFG.rewind.tail;
        rewindBaseT = (base === undefined) ? CFG.ambient.t0 + 3 : base;
        render(rt, 1 / 60);
        mode = "run";
        return "ok-rewind@" + rt;
      },
      cast: ordered.map(function (a) {
        return { k: a.k, L: Math.round(a.L * 100) / 100, hex: a.isHex, outer: a.isOuter,
                 phi: Math.round(a.phi * 100) / 100, t0: a.t0, dur: a.dur };
      }),
      flight: flightAt,
      walls: function (t) { return envAt(WALL_KEYS, t); },
      hexIdx: hexIdx,
      corners: hexCorners,
      wordCap: WORD_CAP,
      shot: function (t, which, size) {
        render(t, 1 / 60);
        var src = which === "fore" ? foreCv : bodyCv;
        var c = document.createElement("canvas");
        c.width = c.height = size || 380;
        var g = c.getContext("2d");
        g.fillStyle = bgCss;
        g.fillRect(0, 0, c.width, c.height);
        var side = Math.min(src.width, src.height);
        g.drawImage(src, (src.width - side) / 2, (src.height - side) / 2,
                    side, side, 0, 0, c.width, c.height);
        return c.toDataURL("image/png");
      }
    };
  }

  requestAnimationFrame(function (now) {
    t0 = now;
    lastNow = now;
    startLoop();
  });
})();
