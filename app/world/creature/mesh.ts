// app/world/creature/mesh.ts
//
// Outline sketch -> solid 3D geometry. Pure maths and Three buffers, no React.
//
// The approach is voxel extrusion rather than contour tracing: every filled
// cell of the sketch becomes a box, and faces are emitted only where a cell
// has no filled neighbour. That gives a watertight solid from an arbitrary
// scribble — including concave shapes and holes, which a THREE.Shape built
// from a traced contour cannot represent without hole detection.
//
// "Filled" is decided by flood-filling the background from the border, not by
// thresholding directly. The difference matters: a drawn outline is a closed
// stroke, and the person drawing it means the enclosed area to be solid. Ink
// thresholding alone would give you a hollow shell of the pen stroke.

import * as THREE from 'three';
import { SKETCH_GRID } from '../terrain';

/** Ink level above which a cell counts as pen stroke rather than paper. */
const INK_THRESHOLD = 0.15;

/** World size of the creature's longest sketch axis, in metres. */
const MESH_SCALE = 2.5;

/** How thick the extrusion is, relative to the sketch plane. */
const MESH_DEPTH = 0.6;

export interface CreatureGeometry {
  geometry: THREE.BufferGeometry;
  /** Height of the generated solid, so the caller can sit it on the ground. */
  height: number;
}

/**
 * Mark every cell reachable from the border without crossing ink.
 *
 * What's left — cells that are neither ink nor reachable — is the interior the
 * person enclosed when they drew the outline.
 */
function floodOutside(outline: Float32Array): Uint8Array {
  const ink = new Uint8Array(SKETCH_GRID * SKETCH_GRID);
  for (let i = 0; i < outline.length; i++) {
    if (outline[i] > INK_THRESHOLD) ink[i] = 1;
  }

  const outside = new Uint8Array(SKETCH_GRID * SKETCH_GRID);
  const queue: number[] = [];

  const push = (x: number, y: number) => {
    if (x < 0 || x >= SKETCH_GRID || y < 0 || y >= SKETCH_GRID) return;
    const idx = y * SKETCH_GRID + x;
    if (!outside[idx] && !ink[idx]) {
      outside[idx] = 1;
      queue.push(idx);
    }
  };

  for (let x = 0; x < SKETCH_GRID; x++) {
    push(x, 0);
    push(x, SKETCH_GRID - 1);
  }
  for (let y = 0; y < SKETCH_GRID; y++) {
    push(0, y);
    push(SKETCH_GRID - 1, y);
  }

  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % SKETCH_GRID;
    const y = (idx / SKETCH_GRID) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return outside;
}

/**
 * Build a solid mesh from a drawn outline.
 *
 * Returns a unit-ish geometry centred on its own bounding box, so the caller
 * positions it by its centre and only needs the height to rest it on terrain.
 */
export function buildCreatureGeometry(outline: Float32Array): CreatureGeometry {
  const outside = floodOutside(outline);
  const solid = (x: number, y: number) => {
    if (x < 0 || x >= SKETCH_GRID || y < 0 || y >= SKETCH_GRID) return false;
    return !outside[y * SKETCH_GRID + x];
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertCount = 0;

  const quad = (
    p0: number[], p1: number[], p2: number[], p3: number[],
    norm: number[],
    uv0: number[], uv1: number[], uv2: number[], uv3: number[],
  ) => {
    positions.push(...p0, ...p1, ...p2, ...p3);
    normals.push(...norm, ...norm, ...norm, ...norm);
    uvs.push(...uv0, ...uv1, ...uv2, ...uv3);
    indices.push(
      vertCount, vertCount + 1, vertCount + 2,
      vertCount, vertCount + 2, vertCount + 3,
    );
    vertCount += 4;
  };

  const d = MESH_SCALE / SKETCH_GRID;
  const z0 = -MESH_DEPTH / 2;
  const z1 = MESH_DEPTH / 2;

  for (let y = 0; y < SKETCH_GRID; y++) {
    for (let x = 0; x < SKETCH_GRID; x++) {
      if (!solid(x, y)) continue;

      const x0 = (x / SKETCH_GRID - 0.5) * MESH_SCALE;
      const x1 = x0 + d;
      // Sketch rows run top-down; world Y runs bottom-up.
      const y1 = ((SKETCH_GRID - y) / SKETCH_GRID - 0.5) * MESH_SCALE;
      const y0 = y1 - d;

      const uMin = x / SKETCH_GRID;
      const uMax = (x + 1) / SKETCH_GRID;
      const vMin = 1 - (y + 1) / SKETCH_GRID;
      const vMax = 1 - y / SKETCH_GRID;

      // Front and back always exist — the extrusion is only one cell deep.
      quad(
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1],
        [uMin, vMin], [uMax, vMin], [uMax, vMax], [uMin, vMax],
      );
      quad(
        [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1],
        [uMax, vMin], [uMin, vMin], [uMin, vMax], [uMax, vMax],
      );

      // Sides only where the neighbour is empty, so interior faces between
      // adjacent cells are never generated. On a typical silhouette that is
      // most of them — the saving is the difference between a mesh that
      // renders and one that doesn't.
      if (!solid(x - 1, y)) {
        quad(
          [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0],
          [0, vMin], [1, vMin], [1, vMax], [0, vMax],
        );
      }
      if (!solid(x + 1, y)) {
        quad(
          [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0],
          [0, vMin], [1, vMin], [1, vMax], [0, vMax],
        );
      }
      if (!solid(x, y - 1)) {
        quad(
          [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0],
          [uMin, 0], [uMax, 0], [uMax, 1], [uMin, 1],
        );
      }
      if (!solid(x, y + 1)) {
        quad(
          [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0],
          [uMin, 0], [uMax, 0], [uMax, 1], [uMin, 1],
        );
      }
    }
  }

  // An empty or all-ink sketch encloses nothing. Fall back to a small box so a
  // stray click still spawns something rather than an invisible row.
  if (positions.length === 0) {
    return { geometry: new THREE.BoxGeometry(1, 1, 1), height: 1 };
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeBoundingBox();

  const height = geom.boundingBox
    ? geom.boundingBox.max.y - geom.boundingBox.min.y
    : 1.2;

  geom.center();
  return { geometry: geom, height };
}

/**
 * Turn the pattern sketch into a skin texture.
 *
 * Nearest filtering on purpose: the grid is 64x64 and smoothing it would blur
 * hand-drawn spots into mud. Repeating it keeps the marks at a scale that
 * reads as skin rather than as one stretched drawing.
 */
export function buildCreatureTexture(pattern: Float32Array): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SKETCH_GRID;
  canvas.height = SKETCH_GRID;
  const ctx = canvas.getContext('2d')!;

  const img = ctx.createImageData(SKETCH_GRID, SKETCH_GRID);
  for (let i = 0; i < pattern.length; i++) {
    const ink = pattern[i];
    const o = i * 4;
    // Unmarked paper is a warm off-white; ink darkens toward it unevenly so
    // the result reads as pigment rather than greyscale.
    img.data[o] = Math.round((1 - ink) * 240);
    img.data[o + 1] = Math.round((1 - ink) * 220);
    img.data[o + 2] = Math.round((1 - ink) * 200);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
