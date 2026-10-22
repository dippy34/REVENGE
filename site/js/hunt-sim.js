/* hunt-sim.js: the deterministic simulation behind the skill stages.

   One file, shared by the browser (window.huntSim) and the server
   (require()). Integer arithmetic only: no floats in the state, no
   Math.random, no Date, no DOM. The same seeds and the same input log give
   the same run, tick for tick, on every engine.

   ---------------------------------------------------------------------
   API
     huntSim.version                 int, bumped on any behaviour change
     huntSim.CODES                   { UP:0, RIGHT:1, DOWN:2, LEFT:3, SEED:9 }
     huntSim.EV                      { EAT:1, RING:2, DIE:4, MARK:8, WIN:16, DRAW:32, END:64 }
     huntSim.bind(cfg, ctx)          pure; ctx = { grid: { rows, cols, alphabet, cells } }
     huntSim.create(cfg, opts)       opts = { device: 'key'|'touch', startRing?: int (0-based, practice) }
     huntSim.feed(st, code)          queue a direction (max 2 queued; a reversal or a repeat is refused)
     huntSim.seed(st, hex32)         supply the next draw seed; false past maxDraws or when malformed
     huntSim.need(st)                index of the next draw (= draws done so far)
     huntSim.step(st)                advance one tick; returns an EV bitmask
     huntSim.view(st, opts?)         { cols, rows, cells: [string], attr: [string], hud, msg, state }
                                     opts.pause: draw the paused screen (practice)
                                     attr: one character per cell: ' ' plain, 'h' bright (the
                                     head, food, stones, the ghost's head, mark glyphs), 'w' dim
                                     glow (everything solid: walls, seams, cinders; fading food),
                                     'd' muted (the border, decoration, the sleeping ghost)
     huntSim.result(st)              { rings, won, ended, ticks, eats, draws }
     huntSim.judge(st, goal)         evaluates a Goal on the finished run (server only)
     huntSim.stats(st)               { turns, minGap, reacts, nearMiss, perfect, ticks, moves, feeds }
                                     turns: direction changes made; minGap: fewest ticks between two
                                     accepted inputs; reacts: ticks from each food spawn to the next
                                     accepted input; perfect: per-mille of turns whose input came on
                                     the very tick of its move; nearMiss: per-mille of turns that were
                                     such last-tick inputs and kept the head from a fatal cell ahead
     huntSim.plausible(stats, plaus, tickMs)   null, or the name of the first failing check, in
                                     order: gap (minGap * tickMs < minGapMs), rate (turns per 1000
                                     ticks > maxTurnRate), react (5+ samples, median * tickMs <
                                     minReactMs), perfect / near (20+ turns, over maxPerfect /
                                     maxNearMiss); a limit of 0 (or 1000 for the per-mille caps) is off
     huntSim.hash(st)                8 hex, FNV-1a over the canonical integer state
     huntSim.replay(cfg, seeds, log, maxTicks, opts)
                                     { result, stats, hash, ringTicks, end: 'over'|'won'|'end'|'max', st }
     huntSim.selfTest()              { ok, hashes }: built-in synthetic golden traces
     huntSim.demoCfg(kind?)          tiny synthetic arena ('run' or 'final'), no content
     huntSim.demoGoal()              a synthetic goal for demoCfg('final'), no content

   ---------------------------------------------------------------------
   SimCfg (integers, strings, arrays and objects only; under 32 KB)
     v: 1, kind: 'run' | 'final'
     w, h                 arena size in cells, inside the border
     map: [string x h]    '.' free, any other character a wall drawn as itself
                          (built by bind() from tile + motifs + the grid)
     tile: { w, h }       tile size; the bound grid lays rows x cols tiles over the arena
     motifs: [[string x tile.h]]   per alphabet position: '#' wall, '.' free (unbound cfg)
     seam: { diff?: [int], v?: [int], h?: [int] }
                          unbound: a wall rises along the edge between two neighbouring
                          tiles when (glyph index of the right or lower tile - glyph index
                          of the other) mod n is listed (v: side by side, h: one above the
                          other; diff: both); seams never close a lane crossing
     seams: [string x h]  bound seam walls ('.' none), present only in rings with seams: 1
     grid: { rows, cols, alphabet, cells }   the bound grid (set by bind)
     start: { x, y, dir, len }               the snake at the start of every ring
     breakTicks           ticks of the pause before each ring (the first one too)
     maxTicks, maxDraws   caps; reaching maxTicks ends the run (cause max)
     rings                the number of rings (int >= 1)
     ringDefs: [ {
       period             ticks per move
       ramp: { every, min } | null           period - 1 every `every` moves, down to min
       goal: { key, touch } | null           foods to clear the ring, per device (null: never clears)
       grow               segments added per food
       rule: string       shown before the ring
       wraith: { delay, len, every, min, wake, den } | null
                          a ghost on the snake's own trail, `delay` moves behind and
                          `len` cells long; the delay drops by 1 every `every` moves down
                          to `min`; it appears only once its head is at least `wake`
                          cells (manhattan) from the snake's head; den: 1 shows it
                          dormant at field.den until then
       fade: { base, per, cinder } | null    food fades after base + per*dist/4 moves
                          (dist = path length at spawn); with cinder: 1 a faded food
                          leaves a wall, unless that would cut the free space or it is
                          within 3 moves of the head
       seams: 0 | 1 } ]      the bound seam walls stand during this ring
     (food spawns only on reachable cells outside dead-end corridors, at least 2 moves away,
      and where the snake has a way out after eating it along the shortest path)
     mark: { ring, radius?, cells: [[q, r, glyph], ...] } | null
                          drawn on a hex figure for the whole break after ring `ring`
                          (1-based), on every end screen and on the pause screen
     field: { stones: [{ x, y, g? }], line?: { row } | { col }, hollow: { x, y } | null,
              den: { x, y } | null, bell: int | null } | null
                          final fields: stones are passable cells (entering one is a
                          touch); bind labels stone i with glyph i of that grid line, or
                          of the grid's alphabet when no line is named;
                          entering the hollow ends the run; the bell ends it after
                          `bell` ticks of play
     trace: { tiles: 0|1 }   record tile entries (final fields)
     say: { [state or cause]: string }        end-screen lines (optional)

   ---------------------------------------------------------------------
   Draws. Every random choice is a draw (a food spawn), made at the start of a
   tick. Draw k reads only seed k: an sfc32 stream from the four big-endian
   u32 words of the 32-hex seed, first 12 outputs discarded (the generator of
   tools/hunt-kit.mjs). A draw that falls due before its seed is supplied is
   deferred; nothing appears until the seed arrives.

   ---------------------------------------------------------------------
   Goal language (judge). A goal is a declarative object over the finished
   run's event trace and final state; it never changes the dynamics or any
   field of result().
     { all: [Goal] } | { any: [Goal] } | { not: Goal }
     { ended: [Cause] }        Cause: won bell hollow wall self wraith max
     { final: Field, cmp: Op, n: Val }     Field: len eats moves ticks rings draws
     { trace: Sel, op: 'is'|'has', list: List }   selected values equal / contain in order
     { trace: Sel, op: 'first'|'last', v: Val }
     { trace: Sel, op: 'count', cmp: Op, n: Val }
     { trace: Sel, op: 'none' }
       Sel  = { k: 'eat'|'touch'|'tile'|'ring'|'wake'|'fade',
                v?: Val, in?: List, out?: List,   filter on the event's glyph
                firsts?: 1,                       keep the first event per key
                by?: 'glyph'|'key' }             what the ops compare (default glyph)
              keys: touch = stone index, tile = tile index (row * cols + col),
                    eat / fade = cell index, ring = ring index
              glyphs: touch = the stone's glyph, tile / eat / fade = the tile's glyph,
                    as alphabet positions of the bound grid
     Val  = int | { cell: [r, c] } (glyph at that grid cell) | { tile: [r, c] } (tile key)
     List = [Val] | { row: r } | { col: c } (glyphs of a grid line)
          | { tilesOf: Val, order: 'row'|'col' } (keys of the tiles holding that glyph)
          | { rev: List } | { cat: [List] } (joined) | { tail: List } (without its first item)
     Op   = 'eq' 'ne' 'lt' 'lte' 'gt' 'gte'
*/
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.huntSim = make();
})(this, function () {
  'use strict';

  var VERSION = 1;
  var CODES = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3, SEED: 9 };
  var EV = { EAT: 1, RING: 2, DIE: 4, MARK: 8, WIN: 16, DRAW: 32, END: 64 };
  var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  var S_RUN = 0, S_BREAK = 1, S_OVER = 2, S_WON = 3, S_END = 4;
  var STATES = ['run', 'break', 'over', 'won', 'end'];
  var C_WALL = 1, C_SELF = 2, C_WRAITH = 3, C_BELL = 4, C_HOLLOW = 5, C_MAX = 6, C_WON = 7;
  var CAUSES = ['', 'wall', 'self', 'wraith', 'bell', 'hollow', 'max', 'won'];
  var T_EAT = 1, T_TOUCH = 2, T_TILE = 3, T_RING = 4, T_WAKE = 5, T_DIE = 6, T_END = 7, T_FADE = 8;
  var KINDS = { eat: T_EAT, touch: T_TOUCH, tile: T_TILE, ring: T_RING, wake: T_WAKE, fade: T_FADE };
  var TRAIL = 1024, TMASK = TRAIL - 1;
  var MAX_REACTS = 512, MAX_TRACE = 40000;

  // characters (the site font carries all of them)
  var CH = {
    head: '@', body: 'o', dead: 'X', food: '\u2022', fading: '\u00b0', cinder: '\u00d7',
    wraith: '~', wraithHead: '\u00a4', den: '\u00a4', hollow: 'O', pad: '\u00b7',
    lit: ['\u00ab', '\u00bb'], seamV: '\u00a6', seamH: '\u2013', dot: '\u00b7'
  };

  /* ---------- small helpers ---------- */

  function isInt(v) { return typeof v === 'number' && (v | 0) === v; }
  function int(v, d) { return isInt(v) ? v : d; }
  function abs(v) { return v < 0 ? -v : v; }

  // sfc32, the same generator as tools/hunt-kit.mjs
  function Rng(a, b, c, d) {
    this.a = a | 0; this.b = b | 0; this.c = c | 0; this.d = d | 0;
    for (var i = 0; i < 12; i++) this.u32();
  }
  Rng.prototype.u32 = function () {
    var a = this.a, b = this.b, c = this.c, d = this.d;
    var t0 = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    var t = (t0 + d) | 0;
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  };
  Rng.prototype.int = function (n) {
    var lim = 4294967296 - (4294967296 % n), x;
    do { x = this.u32(); } while (x >= lim);
    return x % n;
  };

  function hexWords(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]{32}$/.test(hex)) return null;
    var out = [];
    for (var i = 0; i < 4; i++) out.push(parseInt(hex.substr(i * 8, 8), 16) | 0);
    return out;
  }

  function copy(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) { var a = []; for (var i = 0; i < o.length; i++) a.push(copy(o[i])); return a; }
    var r = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = copy(o[k]);
    return r;
  }

  /* ---------- bind: the arena from a grid ---------- */

  function gridOk(g) {
    if (!g || !isInt(g.rows) || !isInt(g.cols) || typeof g.alphabet !== 'string' || typeof g.cells !== 'string') return false;
    if (g.rows < 1 || g.cols < 1 || g.rows > 9 || g.cols > 9 || g.cells.length !== g.rows * g.cols) return false;
    for (var i = 0; i < g.cells.length; i++) if (g.alphabet.indexOf(g.cells.charAt(i)) < 0) return false;
    return true;
  }

  function bind(cfg, ctx) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    var g = ctx && ctx.grid;
    if (!gridOk(g) || !cfg.tile || !Array.isArray(cfg.motifs)) return cfg;
    var tw = cfg.tile.w, th = cfg.tile.h, W = cfg.w, H = cfg.h;
    if (!isInt(tw) || !isInt(th) || tw * g.cols !== W || th * g.rows !== H) return cfg;
    var n = g.alphabet.length;
    var out = {}, k;
    for (k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k) && k !== 'motifs' && k !== 'seam') out[k] = copy(cfg[k]);
    var rows = [], y, x, r, c;
    for (y = 0; y < H; y++) { var line = []; for (x = 0; x < W; x++) line.push('.'); rows.push(line); }
    function gi(rr, cc) { return g.alphabet.indexOf(g.cells.charAt(rr * g.cols + cc)); }
    for (r = 0; r < g.rows; r++) {
      for (c = 0; c < g.cols; c++) {
        var ch = g.cells.charAt(r * g.cols + c);
        var m = cfg.motifs[gi(r, c) % cfg.motifs.length] || [];
        for (y = 0; y < th; y++) {
          var ms = String(m[y] || '');
          for (x = 0; x < tw; x++) if (ms.charAt(x) === '#') rows[r * th + y][c * tw + x] = ch;
        }
      }
    }
    out.map = rows.map(function (l) { return l.join(''); });
    if (cfg.seam && (Array.isArray(cfg.seam.diff) || Array.isArray(cfg.seam.v) || Array.isArray(cfg.seam.h))) {
      // seams run along the tile edges and always leave the lane crossings open
      var sm = [];
      for (y = 0; y < H; y++) { var sl = []; for (x = 0; x < W; x++) sl.push('.'); sm.push(sl); }
      var dv = Array.isArray(cfg.seam.v) ? cfg.seam.v : (cfg.seam.diff || []);
      var dh = Array.isArray(cfg.seam.h) ? cfg.seam.h : (cfg.seam.diff || []);
      for (r = 0; r < g.rows; r++) {
        for (c = 0; c < g.cols; c++) {
          if (c + 1 < g.cols && dv.indexOf((gi(r, c + 1) - gi(r, c) + n) % n) >= 0) {
            for (y = 0; y < th - 1; y++) sm[r * th + y][c * tw + tw - 1] = CH.seamV;
          }
          if (r + 1 < g.rows && dh.indexOf((gi(r + 1, c) - gi(r, c) + n) % n) >= 0) {
            for (x = 0; x < tw - 1; x++) sm[r * th + th - 1][c * tw + x] = CH.seamH;
          }
        }
      }
      out.seams = sm.map(function (l) { return l.join(''); });
    }
    if (out.field && Array.isArray(out.field.stones)) {
      // stone i bears glyph i of a grid line when field.line names one, else of the alphabet
      var ln = out.field.line || null;
      for (var i = 0; i < out.field.stones.length; i++) {
        if (!ln) { if (i < n) out.field.stones[i].g = g.alphabet.charAt(i); continue; }
        var gr = isInt(ln.col) ? i : int(ln.row, 0), gc = isInt(ln.col) ? ln.col : i;
        if (gr < g.rows && gc < g.cols) out.field.stones[i].g = g.cells.charAt(gr * g.cols + gc);
      }
    }
    out.grid = { rows: g.rows, cols: g.cols, alphabet: g.alphabet, cells: g.cells };
    return out;
  }

  /* ---------- create: compile the cfg ---------- */

  function compile(cfg) {
    var W = cfg.w | 0, H = cfg.h | 0, N = W * H, i, x, y;
    if (W < 4 || H < 4 || W > 64 || H > 48) throw new Error('size');
    var wall = new Uint8Array(N), seam = new Uint8Array(N);
    var map = Array.isArray(cfg.map) ? cfg.map : [];
    var seams = Array.isArray(cfg.seams) ? cfg.seams : [];
    for (y = 0; y < H; y++) {
      var ms = String(map[y] || ''), ss = String(seams[y] || '');
      for (x = 0; x < W; x++) {
        var ch = ms.charAt(x);
        if (ch && ch !== '.' && ch !== ' ') wall[y * W + x] = 1;
        var sc = ss.charAt(x);
        if (sc && sc !== '.' && sc !== ' ') seam[y * W + x] = 1;
      }
    }
    var g = gridOk(cfg.grid) ? cfg.grid : null;
    var tile = cfg.tile && isInt(cfg.tile.w) && isInt(cfg.tile.h) ? cfg.tile : null;
    var tw = tile ? tile.w : W, th = tile ? tile.h : H;
    var tcols = Math.max(1, (W / tw) | 0), trows = Math.max(1, (H / th) | 0);
    var tileGlyph = new Int8Array(tcols * trows);
    for (i = 0; i < tileGlyph.length; i++) tileGlyph[i] = -1;
    if (g && tile && g.cols === tcols && g.rows === trows) {
      for (i = 0; i < tileGlyph.length; i++) tileGlyph[i] = g.alphabet.indexOf(g.cells.charAt(i));
    }
    var f = cfg.field || null;
    var stones = [], stoneGlyph = [];
    if (f && Array.isArray(f.stones)) {
      for (i = 0; i < f.stones.length && i < 16; i++) {
        var s = f.stones[i];
        if (!s || !isInt(s.x) || !isInt(s.y) || s.x < 0 || s.y < 0 || s.x >= W || s.y >= H) continue;
        stones.push(s.y * W + s.x);
        stoneGlyph.push(g && typeof s.g === 'string' ? g.alphabet.indexOf(s.g) : -1);
      }
    }
    var stoneAt = new Int8Array(N);
    for (i = 0; i < N; i++) stoneAt[i] = -1;
    for (i = 0; i < stones.length; i++) stoneAt[stones[i]] = i;
    function cellOf(p) { return p && isInt(p.x) && isInt(p.y) && p.x >= 0 && p.y >= 0 && p.x < W && p.y < H ? p.y * W + p.x : -1; }
    var rings = Array.isArray(cfg.ringDefs) && cfg.ringDefs.length ? cfg.ringDefs : [{ period: 8, goal: null }];
    if (isInt(cfg.rings) && cfg.rings >= 1 && cfg.rings < rings.length) rings = rings.slice(0, cfg.rings);
    var st = cfg.start || {};
    return {
      W: W, H: H, N: N, wall: wall, seam: seam,
      tw: tw, th: th, tcols: tcols, trows: trows, tileGlyph: tileGlyph,
      stones: stones, stoneGlyph: stoneGlyph, stoneAt: stoneAt,
      hollow: f ? cellOf(f.hollow) : -1, den: f ? cellOf(f.den) : -1,
      bell: f && isInt(f.bell) && f.bell > 0 ? f.bell : 0,
      final: cfg.kind === 'final' ? 1 : 0,
      rings: rings, nRings: rings.length,
      breakTicks: Math.max(0, int(cfg.breakTicks, 60)),
      maxTicks: Math.max(1, int(cfg.maxTicks, 30000)),
      maxDraws: Math.max(1, Math.min(4096, int(cfg.maxDraws, 600))),
      sx: Math.max(0, Math.min(W - 1, int(st.x, 1))), sy: Math.max(0, Math.min(H - 1, int(st.y, H - 1))),
      sdir: int(st.dir, 1) & 3, slen: Math.max(1, Math.min(N, int(st.len, 3))),
      tiles: cfg.trace && cfg.trace.tiles ? 1 : 0
    };
  }

  function ringNum(r, key, d) { return r && isInt(r[key]) ? r[key] : d; }

  function create(cfg, opts) {
    opts = opts || {};
    var k = compile(cfg);
    k.dev = opts.device === 'touch' ? 1 : 0;
    var N = k.N;
    var s = {
      t: 0, state: S_BREAK, ring: 0, brk: k.breakTicks, rt: 0, mt: 0, period: 8, rampLeft: 0,
      dir: k.sdir, q0: -1, q1: -1, qn: 0, q0t: 0, q1t: 0,
      body: new Int32Array(Math.min(N, 4096)), bh: 0, bl: 0, grow: 0,
      occ: new Uint8Array(N), cinder: new Uint8Array(N), core: new Uint8Array(N),
      food: -1, life: -1, life0: 0, pend: 0, draws: 0, nseed: 0, ncinder: 0,
      seeds: new Int32Array(k.maxDraws * 4),
      eats: 0, reats: 0, cleared: 0, moves: 0, rmoves: 0,
      trail: new Int32Array(TRAIL),
      wd: 0, wawake: 0, wnext: 0, wwoke: 0,
      cause: 0, ringTicks: new Int32Array(k.nRings),
      hits: new Int32Array(Math.max(1, k.stones.length)), tile: -1,
      lastFeed: -1, minGap: 1 << 30, turns: 0, perfectN: 0, forcedN: 0, feeds: 0,
      reacts: new Int32Array(MAX_REACTS), nReacts: 0, spawnT: -1,
      tr: []
    };
    var st = { cfg: cfg, k: k, s: s };
    var start = isInt(opts.startRing) ? Math.max(0, Math.min(k.nRings - 1, opts.startRing)) : 0;
    s.ring = start;
    resetRing(st);
    return st;
  }

  // the snake, the food and the ghost for the ring s.ring, frozen until the break ends
  function resetRing(st) {
    var k = st.k, s = st.s, i;
    var r = k.rings[s.ring];
    for (i = 0; i < s.bl; i++) s.occ[s.body[(s.bh - i + s.body.length) % s.body.length]] = 0;
    s.bl = 0; s.bh = 0; s.grow = 0;
    var len = Math.min(k.slen, s.body.length);
    // tail first, the head last, laid out behind the start cell
    var bx = k.sx, by = k.sy;
    var cells = [];
    for (i = 0; i < len; i++) {
      var cx = bx - DX[k.sdir] * i, cy = by - DY[k.sdir] * i;
      if (cx < 0 || cy < 0 || cx >= k.W || cy >= k.H) break;
      cells.push(cy * k.W + cx);
    }
    for (i = cells.length - 1; i >= 0; i--) pushHead(st, cells[i]);
    s.dir = k.sdir; s.q0 = -1; s.q1 = -1; s.qn = 0;
    s.food = -1; s.life = -1; s.pend = 0;
    for (i = 0; i < k.N; i++) s.cinder[i] = 0;
    s.ncinder = 0;
    s.reats = 0; s.rmoves = 0; s.rt = 0;
    s.period = Math.max(1, ringNum(r, 'period', 8));
    s.rampLeft = r && r.ramp ? Math.max(1, int(r.ramp.every, 1 << 30)) : 0;
    s.mt = s.period;
    var w = r && r.wraith;
    s.wd = w ? Math.max(1, int(w.delay, 30)) : 0;
    s.wnext = w ? Math.max(1, int(w.every, 1 << 30)) : 0;
    s.wawake = 0; s.wwoke = 0;
    s.trail[0] = s.body[s.bh];
    for (i = 0; i < s.hits.length; i++) s.hits[i] = 0;
    s.tile = -1;
    s.spawnT = -1;
    s.state = S_BREAK;
    s.brk = k.breakTicks;
    computeCore(st);
  }

  // free cells outside dead-end corridors: the free space with every cell of degree < 2
  // peeled away, repeatedly. Food only ever spawns here (a dead end is a trap for a snake).
  function computeCore(st) {
    var k = st.k, s = st.s, N = k.N, W = k.W, H = k.H, core = s.core, i, d;
    var deg = new Int8Array(N), q = [];
    for (i = 0; i < N; i++) core[i] = blocked(st, i) ? 0 : 1;
    for (i = 0; i < N; i++) {
      if (!core[i]) continue;
      var x = i % W, y = (i / W) | 0, n = 0;
      for (d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && core[ny * W + nx]) n++;
      }
      deg[i] = n;
      if (n < 2) q.push(i);
    }
    while (q.length) {
      var c = q.pop();
      if (!core[c]) continue;
      core[c] = 0;
      var cx = c % W, cy = (c / W) | 0;
      for (d = 0; d < 4; d++) {
        var ax = cx + DX[d], ay = cy + DY[d];
        if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
        var a = ay * W + ax;
        if (core[a]) { deg[a]--; if (deg[a] < 2) q.push(a); }
      }
    }
  }

  function pushHead(st, cell) {
    var s = st.s, L = s.body.length;
    if (s.bl > 0) s.bh = (s.bh + 1) % L;
    s.body[s.bh] = cell;
    s.bl++;
    s.occ[cell]++;
  }
  function popTail(st) {
    var s = st.s, L = s.body.length;
    var ti = (s.bh - s.bl + 1 + L) % L;
    s.occ[s.body[ti]]--;
    s.bl--;
  }
  function tailCell(st) { var s = st.s, L = s.body.length; return s.body[(s.bh - s.bl + 1 + L) % L]; }

  function trace(st, kind, a, b) {
    var s = st.s;
    if (s.tr.length >= MAX_TRACE) return;
    s.tr.push(kind, s.t, a, b);
  }

  function tileOf(k, cell) {
    var x = cell % k.W, y = (cell / k.W) | 0;
    var c = (x / k.tw) | 0, r = (y / k.th) | 0;
    if (c >= k.tcols || r >= k.trows) return -1;
    return r * k.tcols + c;
  }

  function startPlay(st) {
    var k = st.k, s = st.s;
    s.state = S_RUN;
    s.pend = 1;
    if (k.tiles) { var tl = tileOf(k, s.body[s.bh]); s.tile = tl; trace(st, T_TILE, tl, tl >= 0 ? k.tileGlyph[tl] : -1); }
  }

  /* ---------- inputs and seeds ---------- */

  function feed(st, code) {
    var s = st.s;
    if (!st || s.state > S_BREAK || !isInt(code) || code < 0 || code > 3) return false;
    if (s.qn >= 2) return false;
    var last = s.qn ? (s.qn === 2 ? s.q1 : s.q0) : s.dir;
    if (code === last || code === ((last + 2) & 3)) return false;
    if (s.qn === 0) { s.q0 = code; s.q0t = s.t; } else { s.q1 = code; s.q1t = s.t; }
    s.qn++;
    s.feeds++;
    if (s.lastFeed >= 0 && s.t - s.lastFeed < s.minGap) s.minGap = s.t - s.lastFeed;
    s.lastFeed = s.t;
    if (s.spawnT >= 0 && s.t >= s.spawnT && s.state === S_RUN) {
      if (s.nReacts < MAX_REACTS) s.reacts[s.nReacts++] = s.t - s.spawnT;
      s.spawnT = -1;
    }
    return true;
  }

  function seed(st, hex) {
    var s = st.s, k = st.k;
    if (s.nseed >= k.maxDraws) return false;
    var w = hexWords(hex);
    if (!w) return false;
    for (var i = 0; i < 4; i++) s.seeds[s.nseed * 4 + i] = w[i];
    s.nseed++;
    return true;
  }

  function need(st) { return st.s.draws; }

  /* ---------- pathing (deterministic, used by the dynamics) ---------- */

  function blocked(st, cell) {
    var k = st.k, s = st.s;
    if (k.wall[cell] || s.cinder[cell]) return true;
    if (k.seam[cell] && seamsOn(st)) return true;
    return false;
  }
  function seamsOn(st) { var r = st.k.rings[st.s.ring]; return !!(r && r.seams); }

  // time-aware breadth-first arrival moves from the head: a body cell can be entered once the
  // tail has left it. Fills TB_D (arrival move, -1 unreached) and TB_P (parent cell).
  var TB_Q = null, TB_D = null, TB_P = null, TB_F = null;
  function timeBfs(st) {
    var k = st.k, s = st.s, N = k.N, W = k.W, i;
    if (!TB_Q || TB_Q.length < N) { TB_Q = new Int32Array(N); TB_D = new Int32Array(N); TB_P = new Int32Array(N); TB_F = new Int32Array(N); }
    var D = TB_D, P = TB_P, Q = TB_Q, F = TB_F, L = s.body.length;
    for (i = 0; i < N; i++) { D[i] = -1; F[i] = 0; }
    for (var j = 0; j < s.bl; j++) F[s.body[(s.bh - s.bl + 1 + j + L) % L]] = j + 1 + s.grow;
    var head = s.body[s.bh], qh = 0, qt = 0;
    D[head] = 0; P[head] = -1; Q[qt++] = head;
    while (qh < qt) {
      var c = Q[qh++], x = c % W, y = (c / W) | 0, m = D[c] + 1;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= k.H) continue;
        var n = ny * W + nx;
        if (D[n] >= 0 || blocked(st, n) || F[n] > m) continue;
        D[n] = m; P[n] = c; Q[qt++] = n;
      }
    }
    return D;
  }

  // after taking the found path to `cell` and eating there, can the snake still get out?
  // (it reaches enough free cells, or a cell its own body has left in time)
  function escapes(st, cell, grow) {
    var k = st.k, s = st.s, N = k.N, W = k.W, L = s.body.length, i;
    var body = [], path = [], c = cell;
    while (c >= 0 && c !== s.body[s.bh]) { path.push(c); c = TB_P[c]; }
    for (i = 0; i < s.bl; i++) body.push(s.body[(s.bh - s.bl + 1 + i + L) % L]);
    var g = s.grow;
    for (i = path.length - 1; i >= 0; i--) { body.push(path[i]); if (g > 0) g--; else body.shift(); }
    g += grow;
    var F = {}, seen = {}, need = Math.max(24, body.length * 2 + 6);
    for (i = 0; i < body.length; i++) F[body[i]] = i + 1 + g;
    var q = [cell], at = [0], qi = 0, n = 0;
    seen[cell] = 1;
    while (qi < q.length) {
      var cc = q[qi], m = at[qi] + 1; qi++; n++;
      if (n >= need) return true;
      var x = cc % W, y = (cc / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= k.H) continue;
        var nn = ny * W + nx;
        if (seen[nn] || blocked(st, nn)) continue;
        var fa = F[nn] || 0;
        if (fa > m) continue;
        if (fa > 0 && n >= 2) return true;
        seen[nn] = 1; q.push(nn); at.push(m);
      }
    }
    return false;
  }

  function wraithCells(st, out) {
    var s = st.s, k = st.k, r = k.rings[s.ring], w = r && r.wraith, n = 0;
    if (!w || !s.wawake) return 0;
    var L = Math.max(1, int(w.len, 4));
    for (var j = 0; j < L; j++) {
      var idx = s.rmoves - s.wd - j;
      if (idx < 0) break;
      out[n++] = s.trail[idx & TMASK];
    }
    return n;
  }
  var WC = new Int32Array(256);

  /* ---------- draws ---------- */

  function draw(st) {
    var k = st.k, s = st.s, i;
    var base = s.draws * 4;
    var rng = new Rng(s.seeds[base], s.seeds[base + 1], s.seeds[base + 2], s.seeds[base + 3]);
    s.draws++;
    s.pend--;
    var D = timeBfs(st);
    var nw = wraithCells(st, WC), wset = {};
    for (i = 0; i < nw; i++) wset[WC[i]] = 1;
    var elig = [];
    for (i = 0; i < k.N; i++) {
      if (D[i] < 2 || !s.core[i] || s.occ[i] || k.stoneAt[i] >= 0 || i === k.hollow || i === k.den || wset[i]) continue;
      elig.push(i);
    }
    if (!elig.length) {
      for (i = 0; i < k.N; i++) if (!blocked(st, i) && !s.occ[i] && k.stoneAt[i] < 0 && i !== k.hollow && i !== k.den && !wset[i]) elig.push(i);
    }
    if (!elig.length) { s.food = -1; return; }
    var r = k.rings[s.ring], gr = Math.max(0, ringNum(r, 'grow', 1));
    // up to 8 candidates from this draw's stream, then a scan from a drawn offset: the first
    // cell with a way out (the first candidate when there is none at all)
    var cell = -1, safe = false;
    for (i = 0; i < 8 && !safe; i++) {
      var cand = elig[rng.int(elig.length)];
      if (cell < 0) cell = cand;
      if (escapes(st, cand, gr)) { cell = cand; safe = true; }
    }
    if (!safe) {
      var off = rng.int(elig.length);
      for (i = 0; i < elig.length; i++) {
        var c2 = elig[(off + i) % elig.length];
        if (escapes(st, c2, gr)) { cell = c2; break; }
      }
    }
    s.food = cell;
    if (r && r.fade) {
      var dist = D[cell] > 0 ? D[cell] : 8;
      s.life = Math.max(4, int(r.fade.base, 20) + ((int(r.fade.per, 4) * dist) >> 2));
      s.life0 = s.life;
    } else { s.life = -1; s.life0 = 0; }
    s.spawnT = s.t;
  }

  /* ---------- step ---------- */

  function die(st, cause) {
    var s = st.s;
    s.state = S_OVER;
    s.cause = cause;
    trace(st, T_DIE, cause, 0);
    return EV.DIE;
  }

  function finish(st, cause) {
    var s = st.s;
    s.state = S_END;
    s.cause = cause;
    trace(st, T_END, cause, 0);
    return EV.END;
  }

  function step(st) {
    var k = st.k, s = st.s, ev = 0;
    if (s.state > S_BREAK) return 0;
    s.t++;
    if (s.t >= k.maxTicks) { var e0 = die(st, C_MAX); return e0; }
    if (s.state === S_BREAK) {
      if (s.brk > 0) s.brk--;
      if (s.brk > 0) return 0;
      startPlay(st);
    }
    s.rt++;
    // draws fall due at the start of a tick, and wait for their seed
    while (s.pend > 0 && s.nseed > s.draws && s.draws < k.maxDraws) { draw(st); ev |= EV.DRAW; }
    if (k.bell && s.rt >= k.bell) return ev | finish(st, C_BELL);
    s.mt--;
    if (s.mt > 0) return ev;
    s.mt = s.period;
    ev |= move(st);
    return ev;
  }

  function move(st) {
    var k = st.k, s = st.s, r = k.rings[s.ring], ev = 0, i;
    var applied = false, phase0 = false, od = s.dir;
    if (s.qn > 0) {
      var nd = s.q0, ft = s.q0t;
      s.q0 = s.q1; s.q0t = s.q1t; s.q1 = -1; s.qn--;
      if (nd !== s.dir && nd !== ((s.dir + 2) & 3)) {
        applied = true;
        // fed on the very tick of this move: the last possible moment
        phase0 = ft === s.t - 1;
        s.dir = nd;
      }
    }
    var head = s.body[s.bh], hx = head % k.W, hy = (head / k.W) | 0;
    if (applied) {
      s.turns++;
      if (phase0) {
        s.perfectN++;
        // and going straight on would have been fatal
        if (deadly(st, hx + DX[od], hy + DY[od])) s.forcedN++;
      }
    }
    var nx = hx + DX[s.dir], ny = hy + DY[s.dir];
    if (nx < 0 || ny < 0 || nx >= k.W || ny >= k.H) return die(st, C_WALL);
    var c = ny * k.W + nx;
    if (blocked(st, c)) return die(st, C_WALL);
    if (s.occ[c]) {
      if (!(c === tailCell(st) && s.grow === 0)) return die(st, C_SELF);
    }
    if (s.grow > 0) s.grow--; else popTail(st);
    pushHead(st, c);
    s.moves++; s.rmoves++;
    s.trail[s.rmoves & TMASK] = c;
    // the ghost on the trail
    var w = r && r.wraith;
    if (w) {
      if (s.rmoves === 1 && w.den && !s.wwoke) { s.wwoke = 1; trace(st, T_WAKE, 0, 0); }
      if (!s.wawake) {
        var wi = s.rmoves - s.wd;
        if (wi >= 0) {
          var wc = s.trail[wi & TMASK];
          var dd = abs((wc % k.W) - nx) + abs(((wc / k.W) | 0) - ny);
          if (dd >= int(w.wake, 5)) { s.wawake = 1; if (!w.den) trace(st, T_WAKE, wc, 0); }
        }
      }
      if (s.wawake) {
        var nw = wraithCells(st, WC);
        for (i = 0; i < nw; i++) if (WC[i] === c) return die(st, C_WRAITH);
      }
      s.wnext--;
      if (s.wnext <= 0) {
        s.wnext = Math.max(1, int(w.every, 1 << 30));
        if (s.wd > Math.max(1, int(w.min, 1))) s.wd--;
      }
    }
    // food
    if (c === s.food) {
      s.food = -1; s.life = -1;
      s.eats++; s.reats++;
      s.grow += Math.max(0, ringNum(r, 'grow', 1));
      s.spawnT = -1;
      trace(st, T_EAT, c, k.tiles ? tileOf(k, c) : -1);
      ev |= EV.EAT;
      var goal = r && r.goal ? (k.dev ? r.goal.touch : r.goal.key) : 0;
      if (isInt(goal) && goal > 0 && s.reats >= goal) return ev | clear(st);
      s.pend++;
    }
    // stones, tiles, the hollow
    var si = k.stoneAt[c];
    if (si >= 0) { if (s.hits[si] < 1000000) s.hits[si]++; trace(st, T_TOUCH, si, k.stoneGlyph[si]); }
    if (k.tiles) {
      var tl = tileOf(k, c);
      if (tl !== s.tile) { s.tile = tl; trace(st, T_TILE, tl, tl >= 0 ? k.tileGlyph[tl] : -1); }
    }
    if (c === k.hollow) return ev | finish(st, C_HOLLOW);
    // fading food
    if (s.food >= 0 && s.life > 0) {
      s.life--;
      if (s.life === 0) ev |= fade(st);
    }
    // speed ramp
    if (r && r.ramp && s.rampLeft > 0) {
      s.rampLeft--;
      if (s.rampLeft === 0) {
        s.rampLeft = Math.max(1, int(r.ramp.every, 1 << 30));
        if (s.period > Math.max(1, int(r.ramp.min, 1))) s.period--;
      }
    }
    return ev;
  }

  // would moving the head into (x, y) end the run? (read only)
  function deadly(st, x, y) {
    var k = st.k, s = st.s;
    if (x < 0 || y < 0 || x >= k.W || y >= k.H) return true;
    var c = y * k.W + x;
    if (blocked(st, c)) return true;
    if (s.occ[c] && !(c === tailCell(st) && s.grow === 0)) return true;
    var nw = wraithCells(st, WC);
    for (var i = 0; i < nw; i++) if (WC[i] === c) return true;
    return false;
  }

  function fade(st) {
    var k = st.k, s = st.s, r = k.rings[s.ring], cell = s.food;
    s.food = -1; s.life = -1;
    s.spawnT = -1;
    trace(st, T_FADE, cell, k.tiles ? tileOf(k, cell) : -1);
    if (r && r.fade && r.fade.cinder) {
      var head = s.body[s.bh];
      var dd = abs((cell % k.W) - (head % k.W)) + abs(((cell / k.W) | 0) - ((head / k.W) | 0));
      if (dd >= 4 && !cuts(st, cell)) { s.cinder[cell] = 1; s.ncinder++; computeCore(st); }
    }
    s.pend++;
    return 0;
  }

  // would a wall at `cell` cut the free space in two?
  function cuts(st, cell) {
    var k = st.k, s = st.s, N = k.N, W = k.W, i, total = 0, start = -1;
    s.cinder[cell] = 1;
    for (i = 0; i < N; i++) if (!blocked(st, i)) { total++; if (start < 0) start = i; }
    var seen = new Uint8Array(N), Q = new Int32Array(N), qh = 0, qt = 0, n = 0;
    if (start >= 0) { seen[start] = 1; Q[qt++] = start; }
    while (qh < qt) {
      var c = Q[qh++], x = c % W, y = (c / W) | 0; n++;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= k.H) continue;
        var m = ny * W + nx;
        if (seen[m] || blocked(st, m)) continue;
        seen[m] = 1; Q[qt++] = m;
      }
    }
    s.cinder[cell] = 0;
    return n !== total;
  }

  function clear(st) {
    var k = st.k, s = st.s, ev = EV.RING;
    s.ringTicks[s.ring] = s.t;
    s.cleared++;
    trace(st, T_RING, s.ring, 0);
    if (s.ring + 1 >= k.nRings) {
      s.state = S_WON;
      s.cause = C_WON;
      return ev | EV.WIN;
    }
    s.ring++;
    resetRing(st);
    var m = st.cfg.mark;
    if (m && isInt(m.ring) && m.ring === s.ring) ev |= EV.MARK;
    return ev;
  }

  /* ---------- view ---------- */

  function showMark(st, opts) {
    var m = st.cfg.mark, s = st.s;
    if (!m || !Array.isArray(m.cells)) return false;
    if (opts && opts.pause) return true;
    if (s.state > S_BREAK) return true;
    return s.state === S_BREAK && isInt(m.ring) && m.ring === s.ring && s.ring > 0;
  }

  function view(st, opts) {
    var k = st.k, s = st.s, cfg = st.cfg, W = k.W, H = k.H, x, y, i;
    var g = [], a = [];
    for (y = 0; y < H + 2; y++) {
      var row = [], arow = [];
      for (x = 0; x < W + 2; x++) {
        var edgeY = y === 0 || y === H + 1, edgeX = x === 0 || x === W + 1;
        row.push(edgeY && edgeX ? '+' : edgeY ? '-' : edgeX ? '|' : ' ');
        arow.push(edgeY || edgeX ? 'd' : ' ');
      }
      g.push(row); a.push(arow);
    }
    function put(cell, ch, at) { var cx = cell % W, cy = (cell / W) | 0; g[cy + 1][cx + 1] = ch; a[cy + 1][cx + 1] = at || ' '; }
    var map = Array.isArray(cfg.map) ? cfg.map : [];
    for (y = 0; y < H; y++) {
      var ms = String(map[y] || '');
      for (x = 0; x < W; x++) if (k.wall[y * W + x]) { g[y + 1][x + 1] = ms.charAt(x) || '#'; a[y + 1][x + 1] = 'w'; }
    }
    if (seamsOn(st) && Array.isArray(cfg.seams)) {
      for (y = 0; y < H; y++) {
        var ss = String(cfg.seams[y] || '');
        for (x = 0; x < W; x++) if (k.seam[y * W + x]) { g[y + 1][x + 1] = ss.charAt(x); a[y + 1][x + 1] = 'w'; }
      }
    }
    for (i = 0; i < k.N; i++) if (s.cinder[i]) put(i, CH.cinder, 'w');
    if (k.hollow >= 0) put(k.hollow, CH.hollow, ' ');
    var sg = cfg.field && cfg.field.stones;
    for (i = 0; i < k.stones.length; i++) {
      var sc = k.stones[i], lit = s.hits[i] > 0;
      var ch = sg && sg[i] && typeof sg[i].g === 'string' ? sg[i].g : '?';
      put(sc, ch, 'h');
      var sx = sc % W;
      if (sx > 0 && !blocked(st, sc - 1) && k.stoneAt[sc - 1] < 0 && sc - 1 !== k.hollow) put(sc - 1, lit ? CH.lit[0] : CH.pad, lit ? 'h' : 'd');
      if (sx < W - 1 && !blocked(st, sc + 1) && k.stoneAt[sc + 1] < 0 && sc + 1 !== k.hollow) put(sc + 1, lit ? CH.lit[1] : CH.pad, lit ? 'h' : 'd');
    }
    var r = k.rings[s.ring], w = r && r.wraith;
    if (w && w.den && !s.wawake && k.den >= 0) put(k.den, CH.den, 'd');
    if (s.food >= 0) { var fading = s.life > 0 && s.life * 2 < s.life0; put(s.food, fading ? CH.fading : CH.food, fading ? 'w' : 'h'); }
    if (s.wawake) {
      var nw = wraithCells(st, WC);
      for (i = nw - 1; i >= 0; i--) put(WC[i], i === 0 ? CH.wraithHead : CH.wraith, i === 0 ? 'h' : ' ');
    }
    for (i = s.bl - 1; i >= 0; i--) {
      var bc = s.body[(s.bh - i + s.body.length) % s.body.length];
      put(bc, i === 0 ? (s.state === S_OVER ? CH.dead : CH.head) : CH.body, i === 0 ? 'h' : ' ');
    }
    if (showMark(st, opts)) drawMark(st, g, a);
    var msg = null;
    if (s.state === S_BREAK) {
      var rule = r && typeof r.rule === 'string' ? r.rule : '';
      if (k.final) msg = (cfg.say && typeof cfg.say.pre === 'string') ? cfg.say.pre : (rule || null);
      else msg = 'ring ' + (s.ring + 1) + (rule ? ' \u00b7 ' + rule : '');
    } else if (s.state > S_BREAK) {
      var say = cfg.say || {};
      var cn = CAUSES[s.cause] || '', sn = STATES[s.state];
      msg = typeof say[cn] === 'string' ? say[cn] : typeof say[sn] === 'string' ? say[sn] : sn;
    }
    if (opts && opts.pause) msg = (cfg.say && typeof cfg.say.pause === 'string') ? cfg.say.pause : 'paused';
    var goal = r && r.goal ? (k.dev ? r.goal.touch : r.goal.key) : null;
    return {
      cols: W + 2, rows: H + 2,
      cells: g.map(function (l) { return l.join(''); }),
      attr: a.map(function (l) { return l.join(''); }),
      hud: { ring: s.ring + 1, rings: k.nRings, score: s.reats, goal: isInt(goal) ? goal : null, len: s.bl, tick: s.t },
      msg: msg,
      state: STATES[s.state]
    };
  }

  // the mark on a small hex figure (axial q, r; radius from the cells, at least 3)
  function drawMark(st, g, a) {
    var m = st.cfg.mark, k = st.k, i, R = isInt(m.radius) && m.radius > 0 ? m.radius : 3;
    for (i = 0; i < m.cells.length; i++) {
      var c = m.cells[i];
      if (!c) continue;
      var q = c[0] | 0, rr = c[1] | 0, d = Math.max(abs(q), abs(rr), abs(q + rr));
      if (d > R) R = d;
    }
    if (R > 5) return;
    var w = 4 * R + 1, h = 2 * R + 1, bw = w + 4, bh = h + 2;
    if (bw > k.W || bh > k.H) return;
    var x0 = ((k.W - bw) >> 1) + 1, y0 = ((k.H - bh) >> 1) + 1, x, y;
    for (y = 0; y < bh; y++) {
      for (x = 0; x < bw; x++) {
        var e = y === 0 || y === bh - 1, f = x === 0 || x === bw - 1;
        g[y0 + y][x0 + x] = e && f ? '+' : e ? '-' : f ? '|' : ' ';
        a[y0 + y][x0 + x] = e || f ? 'd' : ' ';
      }
    }
    var at = {};
    for (i = 0; i < m.cells.length; i++) { var mc = m.cells[i]; if (mc && typeof mc[2] === 'string') at[(mc[0] | 0) + ',' + (mc[1] | 0)] = mc[2].charAt(0); }
    for (var r = -R; r <= R; r++) {
      for (var q2 = Math.max(-R, -R - r); q2 <= Math.min(R, R - r); q2++) {
        var col = 2 * q2 + r + 2 * R, key = q2 + ',' + r;
        var gy = y0 + 1 + r + R, gx = x0 + 2 + col;
        g[gy][gx] = at[key] || CH.dot;
        a[gy][gx] = at[key] ? 'h' : 'd';
      }
    }
  }

  /* ---------- results, stats, plausibility ---------- */

  function result(st) {
    var s = st.s;
    return { rings: s.cleared, won: s.state === S_WON, ended: s.state > S_BREAK, ticks: s.t, eats: s.eats, draws: s.draws };
  }

  function stats(st) {
    var s = st.s, reacts = [];
    for (var i = 0; i < s.nReacts; i++) reacts.push(s.reacts[i]);
    var turns = s.turns;
    return {
      turns: turns,
      minGap: s.minGap === (1 << 30) ? st.k.maxTicks : s.minGap,
      reacts: reacts,
      nearMiss: turns ? ((s.forcedN * 1000 / turns) | 0) : 0,
      perfect: turns ? ((s.perfectN * 1000 / turns) | 0) : 0,
      ticks: s.t, moves: s.moves, feeds: s.feeds
    };
  }

  function median(xs) {
    if (!xs.length) return -1;
    var a = xs.slice().sort(function (p, q) { return p - q; });
    return a[(a.length - 1) >> 1];
  }

  // the engine's plausibility rule, in one place: null when plausible
  function plausible(sx, p, tickMs) {
    if (!sx || !p) return null;
    tickMs = tickMs | 0;
    if (isInt(p.minGapMs) && p.minGapMs > 0 && sx.minGap * tickMs < p.minGapMs) return 'gap';
    if (isInt(p.maxTurnRate) && p.maxTurnRate > 0 && sx.ticks > 0 && sx.turns * 1000 > p.maxTurnRate * sx.ticks) return 'rate';
    var md = median(sx.reacts || []);
    if (isInt(p.minReactMs) && p.minReactMs > 0 && (sx.reacts || []).length >= 5 && md >= 0 && md * tickMs < p.minReactMs) return 'react';
    if (isInt(p.maxPerfect) && p.maxPerfect < 1000 && sx.turns >= 20 && sx.perfect > p.maxPerfect) return 'perfect';
    if (isInt(p.maxNearMiss) && p.maxNearMiss < 1000 && sx.turns >= 20 && sx.nearMiss > p.maxNearMiss) return 'near';
    return null;
  }

  /* ---------- judge: the goal language ---------- */

  function glyphAt(st, r, c) {
    var g = st.cfg.grid;
    if (!gridOk(g) || !isInt(r) || !isInt(c) || r < 0 || c < 0 || r >= g.rows || c >= g.cols) return -2;
    return g.alphabet.indexOf(g.cells.charAt(r * g.cols + c));
  }
  function val(st, v) {
    if (isInt(v)) return v;
    if (v && Array.isArray(v.cell)) return glyphAt(st, v.cell[0], v.cell[1]);
    if (v && Array.isArray(v.tile)) {
      var k = st.k;
      if (!isInt(v.tile[0]) || !isInt(v.tile[1]) || v.tile[0] < 0 || v.tile[1] < 0 || v.tile[0] >= k.trows || v.tile[1] >= k.tcols) return -2;
      return v.tile[0] * k.tcols + v.tile[1];
    }
    return -2;
  }
  function list(st, l, depth) {
    if (depth > 8) return null;
    var g = st.cfg.grid, out = [], i;
    if (Array.isArray(l)) { for (i = 0; i < l.length && i < 64; i++) out.push(val(st, l[i])); return out; }
    if (!l || typeof l !== 'object') return null;
    if (l.rev) { var inner = list(st, l.rev, depth + 1); return inner ? inner.reverse() : null; }
    if (Array.isArray(l.cat)) {
      for (i = 0; i < l.cat.length && i < 8; i++) { var part = list(st, l.cat[i], depth + 1); if (!part) return null; out = out.concat(part); }
      return out;
    }
    if (l.tail) { var t2 = list(st, l.tail, depth + 1); return t2 ? t2.slice(1) : null; }
    if (!gridOk(g)) return null;
    if (isInt(l.row)) { if (l.row < 0 || l.row >= g.rows) return null; for (i = 0; i < g.cols; i++) out.push(glyphAt(st, l.row, i)); return out; }
    if (isInt(l.col)) { if (l.col < 0 || l.col >= g.cols) return null; for (i = 0; i < g.rows; i++) out.push(glyphAt(st, i, l.col)); return out; }
    if (l.tilesOf !== undefined) {
      var gv = val(st, l.tilesOf), k = st.k, r, c;
      if (l.order === 'col') { for (c = 0; c < k.tcols; c++) for (r = 0; r < k.trows; r++) if (k.tileGlyph[r * k.tcols + c] === gv) out.push(r * k.tcols + c); }
      else { for (r = 0; r < k.trows; r++) for (c = 0; c < k.tcols; c++) if (k.tileGlyph[r * k.tcols + c] === gv) out.push(r * k.tcols + c); }
      return out;
    }
    return null;
  }
  function cmp(a, op, b) {
    switch (op) {
      case 'eq': return a === b;
      case 'ne': return a !== b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
    }
    return false;
  }
  function select(st, sel, depth) {
    var kind = KINDS[sel && sel.k];
    if (!kind) return null;
    var tr = st.s.tr, out = [], seen = {}, i;
    var fv = sel.v !== undefined ? val(st, sel.v) : null;
    var fin = sel.in !== undefined ? list(st, sel.in, depth + 1) : null;
    var fout = sel.out !== undefined ? list(st, sel.out, depth + 1) : null;
    if ((sel.in !== undefined && !fin) || (sel.out !== undefined && !fout)) return null;
    var byKey = sel.by === 'key';
    for (i = 0; i < tr.length; i += 4) {
      if (tr[i] !== kind) continue;
      var key = tr[i + 2], glyph = tr[i + 3];
      if (kind === T_EAT || kind === T_FADE) {
        var tl = tileOf(st.k, key);
        key = tr[i + 2]; glyph = tl >= 0 ? st.k.tileGlyph[tl] : -1;
      }
      if (fv !== null && glyph !== fv) continue;
      if (fin && fin.indexOf(glyph) < 0) continue;
      if (fout && fout.indexOf(glyph) >= 0) continue;
      if (sel.firsts) { if (seen[key]) continue; seen[key] = 1; }
      out.push(byKey ? key : glyph);
    }
    return out;
  }
  function holds(st, g, depth) {
    if (!g || typeof g !== 'object' || depth > 24) return false;
    var i, s = st.s;
    if (Array.isArray(g.all)) { if (!g.all.length) return false; for (i = 0; i < g.all.length; i++) if (!holds(st, g.all[i], depth + 1)) return false; return true; }
    if (Array.isArray(g.any)) { for (i = 0; i < g.any.length; i++) if (holds(st, g.any[i], depth + 1)) return true; return false; }
    if (g.not !== undefined) return !holds(st, g.not, depth + 1);
    if (Array.isArray(g.ended)) { if (s.state <= S_BREAK) return false; return g.ended.indexOf(CAUSES[s.cause]) >= 0; }
    if (typeof g.final === 'string') {
      var fv = { len: s.bl, eats: s.eats, moves: s.moves, ticks: s.t, rings: s.cleared, draws: s.draws }[g.final];
      if (!isInt(fv)) return false;
      return cmp(fv, g.cmp, val(st, g.n));
    }
    if (g.trace) {
      var vals = select(st, g.trace, depth);
      if (!vals) return false;
      switch (g.op) {
        case 'is': {
          var L = list(st, g.list, depth + 1);
          if (!L || L.length !== vals.length) return false;
          for (i = 0; i < L.length; i++) if (L[i] !== vals[i] || L[i] < 0) return false;
          return true;
        }
        case 'has': {
          var H2 = list(st, g.list, depth + 1), j = 0;
          if (!H2 || !H2.length) return false;
          for (i = 0; i < vals.length && j < H2.length; i++) if (vals[i] === H2[j]) j++;
          return j === H2.length;
        }
        case 'first': return vals.length > 0 && vals[0] === val(st, g.v);
        case 'last': return vals.length > 0 && vals[vals.length - 1] === val(st, g.v);
        case 'count': return cmp(vals.length, g.cmp, val(st, g.n));
        case 'none': return vals.length === 0;
      }
      return false;
    }
    return false;
  }
  function judge(st, goal) {
    if (!st || !st.s || st.s.state <= S_BREAK) return false;
    try { return holds(st, goal, 0); } catch (e) { return false; }
  }

  /* ---------- hash ---------- */

  function hash(st) {
    var s = st.s, h = 0x811c9dc5 | 0, i;
    function w(v) {
      v = v | 0;
      for (var b = 0; b < 4; b++) { h ^= (v >>> (b * 8)) & 255; h = Math.imul(h, 0x01000193); }
    }
    w(VERSION); w(s.t); w(s.state); w(s.ring); w(s.brk); w(s.rt); w(s.mt); w(s.period); w(s.rampLeft);
    w(s.dir); w(s.qn); w(s.q0); w(s.q1); w(s.grow); w(s.bl);
    for (i = s.bl - 1; i >= 0; i--) w(s.body[(s.bh - i + s.body.length) % s.body.length]);
    w(s.food); w(s.life); w(s.life0); w(s.pend); w(s.draws); w(s.nseed);
    w(s.eats); w(s.reats); w(s.cleared); w(s.moves); w(s.rmoves);
    w(s.wd); w(s.wawake); w(s.wnext); w(s.wwoke); w(s.cause); w(s.tile);
    for (i = 0; i < s.cinder.length; i++) if (s.cinder[i]) w(i);
    for (i = 0; i < s.hits.length; i++) w(s.hits[i]);
    for (i = 0; i < s.ringTicks.length; i++) w(s.ringTicks[i]);
    w(s.minGap); w(s.turns); w(s.perfectN); w(s.forcedN); w(s.feeds); w(s.nReacts);
    for (i = 0; i < s.nReacts; i++) w(s.reacts[i]);
    w(s.tr.length);
    for (i = 0; i < s.tr.length; i++) w(s.tr[i]);
    var x = h >>> 0, out = x.toString(16);
    while (out.length < 8) out = '0' + out;
    return out;
  }

  /* ---------- replay ---------- */

  function replay(cfg, seeds, log, maxTicks, opts) {
    var st = create(cfg, opts), next = 0, li = 0, ringTicks = [], t;
    seeds = Array.isArray(seeds) ? seeds : [];
    log = Array.isArray(log) ? log : [];
    var cap = isInt(maxTicks) && maxTicks > 0 ? maxTicks : st.k.maxTicks;
    for (t = 0; t < cap; t++) {
      while (li < log.length && log[li] && log[li][0] <= t) {
        var e = log[li++];
        if (e[0] !== t) continue;
        if (e[1] === CODES.SEED) { if (next < seeds.length) seed(st, seeds[next++]); }
        else feed(st, e[1]);
      }
      var ev = step(st);
      if (ev & EV.RING) ringTicks.push(st.s.t);
      if (st.s.state > S_BREAK) break;
    }
    var s = st.s;
    var end = s.state === S_WON ? 'won' : s.state === S_END ? 'end' : s.state === S_OVER ? (s.cause === C_MAX ? 'max' : 'over') : 'max';
    return { result: result(st), stats: stats(st), hash: hash(st), ringTicks: ringTicks, end: end, st: st };
  }

  /* ---------- synthetic demos and golden traces ---------- */

  var DEMO_MOTIFS = [
    ['.#.', '...'], ['##.', '...'], ['#..', '#..'], ['...', '.#.'], ['#.#', '...']
  ];
  function demoGrid() {
    // a synthetic 5 x 5 latin square over a synthetic alphabet (no content)
    var al = 'abcde', cells = '';
    for (var r = 0; r < 5; r++) for (var c = 0; c < 5; c++) cells += al.charAt((r * 2 + c) % 5);
    return { rows: 5, cols: 5, alphabet: al, cells: cells };
  }
  function demoCfg(kind) { return bind(demoBase(kind), { grid: demoGrid() }); }
  function demoBase(kind) {
    var base = {
      v: 1, kind: kind === 'final' ? 'final' : 'run', w: 15, h: 10, tile: { w: 3, h: 2 },
      motifs: DEMO_MOTIFS, seam: { diff: [1] },
      start: { x: 1, y: 9, dir: 1, len: 3 }, breakTicks: 8, maxTicks: 6000, maxDraws: 200,
      say: { over: 'over', won: 'clear', end: 'end' }
    };
    if (kind === 'final') {
      base.ringDefs = [{ period: 3, goal: null, grow: 1, rule: 'demo field',
        wraith: { delay: 16, len: 3, every: 10, min: 10, wake: 4, den: 1 }, ramp: { every: 30, min: 2 } }];
      base.rings = 1;
      base.field = { stones: [{ x: 2, y: 1 }, { x: 8, y: 1 }, { x: 14, y: 3 }, { x: 5, y: 5 }, { x: 11, y: 7 }],
        line: { row: 0 }, hollow: { x: 8, y: 5 }, den: { x: 14, y: 0 }, bell: 900 };
      base.trace = { tiles: 1 };
      base.mark = null;
    } else {
      base.ringDefs = [
        { period: 3, goal: { key: 3, touch: 2 }, grow: 1, rule: 'demo ring one' },
        { period: 3, goal: { key: 3, touch: 2 }, grow: 1, rule: 'demo ring two',
          wraith: { delay: 14, len: 3, every: 12, min: 9, wake: 4 }, fade: { base: 14, per: 6, cinder: 1 } },
        { period: 2, goal: { key: 2, touch: 2 }, grow: 1, rule: 'demo ring three', seams: 1 }
      ];
      base.rings = base.ringDefs.length;
      base.mark = { ring: 1, radius: 2, cells: [[0, 0, 'a'], [1, 0, 'b'], [2, 0, 'c']] };
    }
    return base;
  }
  function demoGoal() {
    // synthetic: touch the stones in the order of the grid's first row, then reach the hollow
    return { all: [{ trace: { k: 'touch' }, op: 'is', list: { row: 0 } }, { ended: ['hollow'] }] };
  }
  function demoSeeds(n, salt) {
    var out = [], h = (0x9e3779b9 ^ salt) | 0;
    for (var i = 0; i < n; i++) {
      var s = '';
      for (var j = 0; j < 4; j++) {
        h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ (i * 4 + j);
        var x = (h >>> 0).toString(16);
        while (x.length < 8) x = '0' + x;
        s += x;
      }
      out.push(s);
    }
    return out;
  }
  // a tiny deterministic autopilot for the golden traces: at each move, the safe direction that
  // brings the head nearest the food (straight on when tied); seeds fed one draw ahead
  function autoplay(cfg, seeds, opts, maxTicks, holdSeedsUntil, lazy) {
    var st = create(cfg, opts), log = [], next = 0, t;
    for (t = 0; t < maxTicks; t++) {
      var s = st.s, k = st.k;
      while (next < seeds.length && next <= s.draws + 1 && t >= (holdSeedsUntil || 0)) { seed(st, seeds[next++]); log.push([t, CODES.SEED]); }
      if (s.state === S_RUN && s.mt === 1) {
        var head = s.body[s.bh], hx = head % k.W, hy = (head / k.W) | 0, best = -1, bestV = 1 << 30;
        var fx = s.food >= 0 && !lazy ? s.food % k.W : hx, fy = s.food >= 0 && !lazy ? (s.food / k.W) | 0 : hy;
        for (var i = 0; i < 3; i++) {
          var d = i === 0 ? s.dir : (s.dir + (i === 1 ? 1 : 3)) & 3;
          var nx = hx + DX[d], ny = hy + DY[d];
          if (deadly(st, nx, ny)) continue;
          var v = lazy ? (i === 0 ? 0 : 1) : abs(nx - fx) + abs(ny - fy);
          if (v < bestV) { bestV = v; best = d; }
        }
        if (best >= 0 && best !== s.dir && feed(st, best)) log.push([t, best]);
      }
      step(st);
      if (st.s.state > S_BREAK) break;
    }
    return { st: st, log: log };
  }
  var GOLDEN = ['10f57c40', 'ef7c51f8', 'ee2b157f', '63156ad0'];
  function selfTest() {
    var hashes = [], ok = true, cases = [
      { cfg: demoCfg('run'), seeds: demoSeeds(80, 1), opts: { device: 'key' }, hold: 0 },
      { cfg: demoCfg('run'), seeds: demoSeeds(80, 4), opts: { device: 'touch', startRing: 1 }, hold: 0 },
      { cfg: demoCfg('final'), seeds: demoSeeds(60, 3), opts: { device: 'key' }, hold: 0 },
      { cfg: demoCfg('run'), seeds: demoSeeds(80, 6), opts: { device: 'key', startRing: 1 }, hold: 30, lazy: 1 }
    ];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i], live = autoplay(c.cfg, c.seeds, c.opts, 6000, c.hold, c.lazy);
      var rep = replay(c.cfg, c.seeds, live.log, 6000, c.opts);
      if (rep.hash !== hash(live.st)) ok = false;
      hashes.push(rep.hash);
      if (rep.hash !== GOLDEN[i]) ok = false;
    }
    return { ok: ok, hashes: hashes };
  }

  return {
    version: VERSION, CODES: CODES, EV: EV,
    bind: bind, create: create, feed: feed, seed: seed, need: need, step: step,
    view: view, result: result, judge: judge, stats: stats, plausible: plausible,
    hash: hash, replay: replay, selfTest: selfTest, demoCfg: demoCfg, demoGoal: demoGoal,
    // internal helpers for tests and planners (pure reads, no state change)
    _: { autoplay: autoplay, demoSeeds: demoSeeds, demoBase: demoBase, demoGrid: demoGrid, tileOf: tileOf, blocked: blocked, deadly: deadly, wraithCells: wraithCells, tailCell: tailCell, DX: DX, DY: DY, CAUSES: CAUSES, STATES: STATES }
  };
});
