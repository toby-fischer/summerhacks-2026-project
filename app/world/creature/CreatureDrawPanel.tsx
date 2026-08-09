// app/world/creature/CreatureDrawPanel.tsx
//
// Two-step creature sketching: silhouette, then the marks on it.
//
// Splitting it in two is what makes the results look intentional. Asked for
// one drawing, people draw an outline with details inside it, and the details
// become part of the solid — a spotted animal comes out lumpy. Asking for the
// shape first and the pattern second maps each drawing onto the thing it
// actually controls: geometry, then texture.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SKETCH_GRID } from '../terrain';

/** Drawing surface resolution. Downsampled to SKETCH_GRID on capture. */
const CANVAS_PX = 512;

const COLORS = [
  { name: 'Black', value: '#000000' },
  { name: 'Charcoal', value: '#4b5563' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'White / Eraser', value: '#ffffff' },
];

const SIZES = [
  { label: 'S', size: 6 },
  { label: 'M', size: 16 },
  { label: 'L', size: 28 },
];

export function CreatureDrawPanel({
  onCommit,
  onCancel,
}: {
  onCommit: (outline: Float32Array<ArrayBuffer>, pattern: Float32Array<ArrayBuffer>) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'outline' | 'pattern'>('outline');
  const [outline, setOutline] = useState<Float32Array<ArrayBuffer> | null>(null);
  const [color, setColor] = useState('#000000');
  const [markerSize, setMarkerSize] = useState(14);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  // Wipe to white on mount and between steps. Without this the outline stays
  // visible under the pattern and gets captured into it a second time.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
  }, [step]);

  // Esc cancels, matching every other panel in the world.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const coords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };

  const stroke = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = markerSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    },
    [color, markerSize],
  );

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pos = coords(e);
    if (!pos) return;
    drawing.current = true;
    lastPos.current = pos;
    // Draw a zero-length segment so a single tap leaves a dot.
    stroke(pos, pos);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const pos = coords(e);
    if (!pos || !lastPos.current) return;
    stroke(lastPos.current, pos);
    lastPos.current = pos;
  };

  const onUp = () => {
    drawing.current = false;
    lastPos.current = null;
  };

  const clear = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
  };

  /** Downsample the canvas to the stored grid, averaging ink per cell. */
  const capture = useCallback((): Float32Array<ArrayBuffer> => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    const grid = new Float32Array(SKETCH_GRID * SKETCH_GRID);
    if (!c || !ctx) return grid;

    const img = ctx.getImageData(0, 0, c.width, c.height);
    const step = c.width / SKETCH_GRID;

    for (let gy = 0; gy < SKETCH_GRID; gy++) {
      for (let gx = 0; gx < SKETCH_GRID; gx++) {
        let acc = 0;
        let n = 0;
        const yEnd = Math.floor((gy + 1) * step);
        const xEnd = Math.floor((gx + 1) * step);
        for (let y = Math.floor(gy * step); y < yEnd; y++) {
          for (let x = Math.floor(gx * step); x < xEnd; x++) {
            const i = (y * c.width + x) * 4;
            const lum =
              (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
            acc += 1 - lum;
            n++;
          }
        }
        grid[gy * SKETCH_GRID + gx] = n ? acc / n : 0;
      }
    }
    return grid;
  }, []);

  const next = () => {
    setOutline(capture());
    setStep('pattern');
    setMarkerSize(20);
  };

  const done = () => {
    if (!outline) return;
    onCommit(outline, capture());
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">
          {step === 'outline' ? 'Draw the shape' : 'Paint the markings'}
        </h2>
        <p className="mt-1 text-sm text-white/60">
          {step === 'outline'
            ? 'A closed silhouette, from the side. Whatever you enclose becomes solid.'
            : 'Spots, stripes, eyes — these become its skin.'}
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
          <div className="flex flex-wrap gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => setColor(c.value)}
                title={c.name}
                className={`h-6 w-6 rounded-full border transition-transform ${
                  color === c.value
                    ? 'scale-110 border-white ring-2 ring-white/50'
                    : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {SIZES.map((s) => (
              <button
                key={s.label}
                onClick={() => setMarkerSize(s.size)}
                className={`h-7 w-7 rounded-md text-xs font-semibold transition ${
                  markerSize === s.size
                    ? 'bg-white text-black'
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <canvas
          ref={canvasRef}
          width={CANVAS_PX}
          height={CANVAS_PX}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="mt-3 aspect-square w-full cursor-crosshair touch-none rounded-lg bg-white"
        />

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            onClick={clear}
            className="rounded-md px-3 py-2 text-xs text-white/50 transition hover:text-white/80"
          >
            Clear
          </button>

          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 transition hover:bg-white/10"
            >
              Cancel
            </button>
            {step === 'outline' ? (
              <button
                onClick={next}
                className="rounded-md bg-amber-500 px-5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-amber-400"
              >
                Next: markings
              </button>
            ) : (
              <button
                onClick={done}
                className="rounded-md bg-emerald-500 px-5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400"
              >
                Bring it to life
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
