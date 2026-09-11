import wenSvg from './assets/calligraphy/wen.svg?raw';
import jieSvg from './assets/calligraphy/jie.svg?raw';

const WRITING_SPEED = 1.2;
export const WRITING_START = 3.0;
export const WRITING_END = WRITING_START + 7.5 / WRITING_SPEED;
export const DURATION = WRITING_END + 1.5;
const WIDTH = 768, HEIGHT = 1024;

type Stroke = {
  outline: Path2D;
  points: { x: number; y: number }[];
  x: number; y: number; scale: number;
  start: number; duration: number; weight: number;
};

/** Stroke outlines and centerlines: AnimCJK / Arphic Public License; see assets/calligraphy. */
export function createCalligraphy() {
  const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d')!;
  const strokes: Stroke[] = [];
  const parser = new DOMParser();
  [wenSvg, jieSvg].forEach((source, glyph) => {
    const svg = parser.parseFromString(source, 'image/svg+xml');
    const outlines = [...svg.querySelectorAll('path[id]')];
    const medians = [...svg.querySelectorAll('path[clip-path]')];
    if (outlines.length !== medians.length) throw new Error('Invalid calligraphy stroke data');
    medians.forEach((median, i) => {
      const measure = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      measure.setAttribute('d', median.getAttribute('d')!);
      const length = measure.getTotalLength();
      const count = Math.ceil(length / 5);
      const points = Array.from({ length: count + 1 }, (_, index) => {
        const point = measure.getPointAtLength(length * index / count);
        return { x: point.x, y: point.y };
      });
      strokes.push({
        outline: new Path2D(outlines[i].getAttribute('d')!), points,
        x: glyph === 0 ? 190 : 185, y: glyph === 0 ? 100 : 480, scale: 390 / 1024,
        start: 0, duration: 0, weight: Math.min(.82, .20 + length / 1600),
      });
    });
  });
  const gap = .07 / WRITING_SPEED;
  const characterGap = .25 / WRITING_SPEED;
  const writingTime = WRITING_END - WRITING_START - gap * (strokes.length - 1) - characterGap;
  const totalWeight = strokes.reduce((sum, stroke) => sum + stroke.weight, 0);
  let cursor = WRITING_START;
  strokes.forEach((stroke, i) => {
    if (i === 4) cursor += characterGap;
    stroke.start = cursor; stroke.duration = stroke.weight / totalWeight * writingTime;
    cursor += stroke.duration + gap;
  });
  let lastFrame = -1;
  function update(seconds: number) {
    // Texture uploads are capped at 30 Hz; the book itself stays at display refresh rate.
    const frame = Math.round(Math.max(0, Math.min(DURATION, seconds < WRITING_START ? 0 : seconds)) * 30);
    if (frame === lastFrame) return false;
    lastFrame = frame;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const now = frame / 30;
    for (const stroke of strokes) {
      const progress = Math.max(0, Math.min(1, (now - stroke.start) / stroke.duration));
      if (!progress) continue;
      // Red stores deposited pigment, green stores fresh, still-wet ink.
      const wetness = Math.max(0, 1 - (now - stroke.start) / 1.8);
      const pigment = `rgb(255,${Math.round(wetness * 255)},0)`;
      ctx.save(); ctx.translate(stroke.x, stroke.y); ctx.scale(stroke.scale, stroke.scale);
      if (progress >= 1) {
        ctx.fillStyle = pigment; ctx.fill(stroke.outline);
      } else {
        ctx.clip(stroke.outline);
        // A slightly slower landing/lift leaves a natural, tapered brush silhouette.
        const travel = progress * progress * (3 - 2 * progress);
        const at = travel * (stroke.points.length - 1);
        const index = Math.floor(at), fraction = at - index;
        ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i <= index; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        const previous = stroke.points[index], next = stroke.points[Math.min(index + 1, stroke.points.length - 1)];
        ctx.lineTo(previous.x + (next.x - previous.x) * fraction, previous.y + (next.y - previous.y) * fraction);
        ctx.lineWidth = 140; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = pigment; ctx.stroke();
      }
      ctx.restore();
    }
    return true;
  }
  update(0);
  return { canvas, update, strokeCount: strokes.length };
}
