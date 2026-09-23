type Particle = { bx: number; by: number; dx: number; dy: number; size: number; jitter: number; turn: number };
type Color = [number, number, number];

/** The approved v3 field: autonomous motion, with no pointer interaction. */
export function createTranslationParticles(canvas: HTMLCanvasElement, dialog: HTMLDialogElement) {
  const context = canvas.getContext("2d");
  if (!context) return { update: (_phase: number, _running: boolean) => {}, dispose: () => {} };
  const ctx = context;
  const stage = canvas.parentElement!;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let phase = 0, running = false, visible = false, disposed = false, raf = 0, previous = 0;
  let width = 680, height = 332, seconds = 18.2, points: Particle[] = [], frames = 0;
  let field = { x: .23, y: .19 };
  let seed = 846137;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const table = new Float32Array(64 * 64);
  for (let i = 0; i < table.length; i++) table[i] = random();
  function noise(x: number, y: number) {
    const ix = Math.floor(x), iy = Math.floor(y), tx = smooth(x - ix), ty = smooth(y - iy);
    const at = (a: number, b: number) => table[(a & 63) + (b & 63) * 64]!;
    return mix(mix(at(ix, iy), at(ix + 1, iy), tx), mix(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty);
  }
  // Minimum-distance sampling prevents a grid and avoids clumps of overlapping marks.
  function distribute() {
    const spacing = width < 450 ? 10.0 : 12.2;
    const size = spacing / Math.SQRT2;
    const cols = Math.ceil((width + 40) / size), rows = Math.ceil((height + 40) / size);
    const grid = new Int32Array(cols * rows).fill(-1);
    const sample: Particle[] = [], active: number[] = [];
    const add = (x: number, y: number) => {
      const id = sample.length;
      sample.push({ bx: x - 20, by: y - 20, dx: 0, dy: 0, size: .25, jitter: random(), turn: random() * 6.28 });
      active.push(id); grid[Math.floor(x / size) + Math.floor(y / size) * cols] = id;
    };
    add((width + 40) * .5, (height + 40) * .5);
    while (active.length) {
      const slot = Math.floor(random() * active.length), origin = sample[active[slot]!]!;
      let found = false;
      for (let trial = 0; trial < 18; trial++) {
        const angle = random() * Math.PI * 2, radius = spacing * (1 + random());
        const x = origin.bx + 20 + Math.cos(angle) * radius, y = origin.by + 20 + Math.sin(angle) * radius;
        if (x < 0 || y < 0 || x >= width + 40 || y >= height + 40) continue;
        const gx = Math.floor(x / size), gy = Math.floor(y / size);
        let clear = true;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(rows - 1, gy + 2) && clear; yy++) {
          for (let xx = Math.max(0, gx - 2); xx <= Math.min(cols - 1, gx + 2); xx++) {
            const id = grid[xx + yy * cols]!;
            if (id < 0) continue;
            const other = sample[id]!;
            if ((other.bx + 20 - x) ** 2 + (other.by + 20 - y) ** 2 < spacing ** 2) { clear = false; break; }
          }
        }
        if (clear) { add(x, y); found = true; break; }
      }
      if (!found) { active[slot] = active[active.length - 1]!; active.pop(); }
    }
    points = sample;
  }
  const particlePalette = ['--particle-ink', '--particle-clay', '--particle-gold'].map(name => {
    const hex = getComputedStyle(canvas).getPropertyValue(name).trim();
    return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
  });
  function particleColor(value: number) {
    // Spatially related colors, rather than assigning a random color per particle.
    const [ink, clay, gold] = particlePalette as [Color, Color, Color];
    const v = clamp((value - .16) / .45);
    const first = v < .79, a = first ? ink : clay, b = first ? clay : gold;
    const t = first ? v / .79 : (v - .79) / .21;
    return `rgb(${Math.round(mix(a[0], b[0], t))},${Math.round(mix(a[1], b[1], t))},${Math.round(mix(a[2], b[2], t))})`;
  }
  function paint(dt: number, snap = false) {
    const t = seconds, span = Math.max(width, height * 1.4);
    const autoX = .5 + Math.sin(t * .37) * .28 + (noise(t * .17 + 8, 3) - .5) * .22;
    const autoY = .45 + Math.sin(t * .53 + 1.7) * .34 + (noise(14, t * .19 + 5) - .5) * .26;
    const targetX = autoX;
    const targetY = autoY;
    const follow = snap ? 1 : 1 - Math.exp(-dt * 3.5);
    field.x = mix(field.x, targetX, follow); field.y = mix(field.y, targetY, follow);
    const cx = field.x * width, cy = field.y * height;
    const radius = span * (.43 + Math.sin(t * .8) * .1 + Math.sin(t * 1.3 + 1) * .035);
    const phaseStrength = phase === 0 ? .9 : phase === 3 ? .22 : 1;
    const relax = snap ? 1 : 1 - Math.exp(-dt * 9);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    let bright = 0;
    for (const p of points) {
      const x = p.bx, y = p.by, u = x / span, v = y / span;
      const rx = x - cx, ry = y - cy, dist = Math.hypot(rx, ry), angle = Math.atan2(ry, rx);
      const warp = (noise(u * 4 + t * .24, v * 4 + 24) - .5) * span * .06;
      const edge = (dist + warp - radius) / (span * .14);
      const wave = Math.exp(-edge * edge * 2.2);
      const crest = Math.exp(-edge * edge * 20);
      const body = clamp((radius - dist) / (span * .1)) * .12;
      const base = noise(u * 3.3 + 17 + t * .11, v * 3.3 + 7 - t * .08);
      const amp = (.18 + base * base * .32 + wave * .68 + crest * .32 + body) * phaseStrength;
      p.size = mix(p.size, amp, relax);
      const n1 = noise(u * 5 + t * .23, v * 5 + 9), n2 = noise(u * 5 + 19, v * 5 - t * .2);
      const shiver = noise(u * 18 + t * .5, v * 18 + 3);
      const push = crest * span * .022;
      const dx = (n1 - .5) * 38 + Math.sin(u * 22 + v * 9 + t * 2.8) * 7.5 + Math.cos(angle) * push;
      const dy = (n2 - .5) * 34 + Math.cos(v * 22 + u * 9 + t * 2.3) * 7.5 + Math.sin(angle) * push;
      p.dx = mix(p.dx, dx, relax); p.dy = mix(p.dy, dy, relax);
      const length = clamp(1.2 + p.size * 3.8 * (.8 + p.jitter * .28), 1.2, 6.0);
      const thickness = Math.max(.85, length * .34);
      const px = x + p.dx, py = y + p.dy;
      const textClearance = Math.exp(-Math.pow((px - width / 2) / Math.min(210, width * .38), 6) - Math.pow((py - height * .5) / 69, 6));
      const alpha = clamp(.48 + p.size * .72, .48, 1) * (1 - textClearance * .82);
      if (alpha < .01) continue;
      if (length > 1.2) bright++;
      const direction = angle + (shiver - .5) * 1.15;
      const half = Math.max(0, (length - thickness) * .5);
      ctx.strokeStyle = particleColor(noise(u * 2.7 + 31 + t * .11, v * 2.7 + 17 - t * .08) ** 1.3);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.moveTo(px - Math.cos(direction) * half, py - Math.sin(direction) * half);
      ctx.lineTo(px + Math.cos(direction) * half + .001, py + Math.sin(direction) * half);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    frames++;
    canvas.dataset.frame = String(frames);
    canvas.dataset.particles = String(points.length);
    canvas.dataset.visibleParticles = String(bright);
  }
  function isVisible(): boolean {
    return !disposed && dialog.open && dialog.dataset.mode === "progress" && visible && !document.hidden;
  }
  function isRunning(): boolean { return isVisible() && running && !reduced.matches; }
  function tick(now: number): void {
    raf = 0;
    if (!isRunning()) return;
    const dt = Math.min((now - previous) / 1000 || 1 / 60, .05);
    previous = now; seconds += dt; paint(dt);
    raf = requestAnimationFrame(tick);
  }
  function syncPlayback(): void {
    if (!isRunning()) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { previous = performance.now(); raf = requestAnimationFrame(tick); }
  }
  const resize = new ResizeObserver(() => {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width === Math.round(rect.width * dpr) && canvas.height === Math.round(rect.height * dpr)) return;
    width = rect.width; height = rect.height;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    distribute(); paint(0, true); syncPlayback();
  });
  const intersection = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? false;
    syncPlayback();
  });
  const mutation = new MutationObserver(syncPlayback);
  resize.observe(stage);
  intersection.observe(stage);
  mutation.observe(dialog, { attributes: true, attributeFilter: ["open", "data-mode"] });
  document.addEventListener("visibilitychange", syncPlayback);
  reduced.addEventListener("change", syncPlayback);
  return {
    update(nextPhase: number, nextRunning: boolean): void {
      const changed = phase !== nextPhase || running !== nextRunning;
      phase = nextPhase; running = nextRunning;
      if (changed && !running && isVisible()) paint(0, true);
      syncPlayback();
    },
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect(); intersection.disconnect(); mutation.disconnect();
      document.removeEventListener("visibilitychange", syncPlayback);
      reduced.removeEventListener("change", syncPlayback);
    },
  };
}
