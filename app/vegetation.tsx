'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface VegetationInstance {
  position: [number, number, number];
  rotation: number;
  scale: [number, number, number];
  color: [number, number, number];
  normal: [number, number, number];
}

export interface VegetationPatch {
  id: string;
  type: string;
  instances: VegetationInstance[];
}

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
};

const seededRandom = (seed: number) => {
  let value = seed;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0xffffffff;
  };
};

const vegetationColor = (type: string) => {
  const lower = type.toLowerCase();
  const color = new THREE.Color();

  // Species-specific base palettes. These are deliberately separated rather
  // than making every plant a generic green sphere.
  if (lower.includes('cherry')) return color.set('#e59bbf');
  if (lower.includes('blossom')) return color.set('#f2c4d9');
  if (lower.includes('dead') || lower.includes('withered') || lower.includes('burnt')) {
    return color.set('#665847');
  }
  if (lower.includes('pine') || lower.includes('spruce') || lower.includes('fir')) {
    return color.set('#28533b');
  }
  if (lower.includes('oak')) return color.set('#47733a');
  if (lower.includes('maple')) return color.set('#a83f45');
  if (lower.includes('willow')) return color.set('#6f914b');
  if (lower.includes('palm') || lower.includes('coconut') || lower.includes('date')) {
    return color.set('#8bb356');
  }
  if (lower.includes('cactus') || lower.includes('agave') || lower.includes('aloe')) {
    return color.set('#9fbf5d');
  }
  if (lower.includes('fern')) return color.set('#3f7b4a');
  if (lower.includes('grass') || lower.includes('reed') || lower.includes('wheat')) {
    return color.set('#78964b');
  }
  if (lower.includes('mushroom') || lower.includes('fungus')) return color.set('#a26b50');
  if (lower.includes('rose')) return color.set('#3f713d');
  if (lower.includes('tulip')) return color.set('#4d7c3f');
  if (lower.includes('sunflower')) return color.set('#688e3e');
  if (lower.includes('bush') || lower.includes('shrub') || lower.includes('hedge')) {
    return color.set('#47743d');
  }
  return color.set('#568544');
};

type PlantShape =
  | 'oak' | 'pine' | 'maple' | 'willow' | 'palm' | 'cactus'
  | 'succulent' | 'flower' | 'rose' | 'tulip' | 'sunflower'
  | 'grass' | 'fern' | 'bush' | 'shrub' | 'mushroom' | 'generic';

export const VEGETATION_LIBRARY: { type: string; name: string }[] = [
  { type: 'oak', name: 'Oak' },
  { type: 'pine', name: 'Pine' },
  { type: 'maple', name: 'Maple' },
  { type: 'willow', name: 'Willow' },
  { type: 'palm', name: 'Palm' },
  { type: 'cactus', name: 'Cactus' },
  { type: 'flower', name: 'Flower' },
  { type: 'rose', name: 'Rose' },
  { type: 'tulip', name: 'Tulip' },
  { type: 'sunflower', name: 'Sunflower' },
  { type: 'grass', name: 'Grass' },
  { type: 'fern', name: 'Fern' },
  { type: 'agave', name: 'Agave' },
  { type: 'orchid', name: 'Orchid' },
  { type: 'tumbleweed', name: 'Tumbleweed' },
  { type: 'bush', name: 'Bush' },
  { type: 'mushroom', name: 'Mushroom' },
  { type: 'generic', name: 'Generic' },
];

export const BIOMES: {
  type: string;
  name: string;
  plants: { type: string; weight: number }[];
}[] = [
  {
    type: 'temperate-forest',
    name: 'Temperate Forest',
    plants: [
      { type: 'oak', weight: 20 },
      { type: 'maple', weight: 25 },
      { type: 'pine', weight: 40 },
      { type: 'rose', weight: 5 },
      { type: 'fern', weight: 10 },
    ],
  },
  {
    type: 'rainforest',
    name: 'Rainforest',
    plants: [
      { type: 'palm', weight: 15 },
      { type: 'willow', weight: 25 },
      { type: 'oak', weight: 20 },
      { type: 'bush', weight: 10 },
      { type: 'mushroom', weight: 10 },
      { type: 'orchid', weight: 10 },
      { type: 'fern', weight: 10 },
    ],
  },
  {
    type: 'desert',
    name: 'Desert',
    plants: [
      { type: 'palm', weight: 5 },
      { type: 'cactus', weight: 30 },
      { type: 'agave', weight: 30 },
      { type: 'tumbleweed', weight: 30 },
      { type: 'grass', weight: 5 },
    ],
  },
  {
    type: 'grassland',
    name: 'Grassland',
    plants: [
      { type: 'grass', weight: 50 },
      { type: 'flower', weight: 10 },
      { type: 'sunflower', weight: 20 },
      { type: 'tulip', weight: 10 },
      { type: 'bush', weight: 10 },
    ],
  },
];

export const biomeMap = new Map(BIOMES.map((biome) => [biome.type, biome]));

type PlantStyle = {
  species: PlantShape;
  height: number;
  trunkRadius: number;
  canopyRadius: number;
  trunkColor: THREE.Color;
  leafColor: THREE.Color;
  leafDark: THREE.Color;
  bloomColor: THREE.Color | null;
  accentColor: THREE.Color;
  detail: number;
  lean: number;
  asymmetry: number;
};

const plantStyleFromType = (type: string): PlantStyle => {
  const lower = type.toLowerCase();
  const rand = seededRandom(hashString(type));

  const species: PlantShape =
    /rose/.test(lower) ? 'rose' :
    /tulip/.test(lower) ? 'tulip' :
    /sunflower/.test(lower) ? 'sunflower' :
    /cherry|blossom/.test(lower) ? 'flower' :
    /palm|coconut|date/.test(lower) ? 'palm' :
    /willow/.test(lower) ? 'willow' :
    /pine|spruce|fir|cedar|redwood|sequoia/.test(lower) ? 'pine' :
    /oak/.test(lower) ? 'oak' :
    /maple/.test(lower) ? 'maple' :
    /cactus|saguaro/.test(lower) ? 'cactus' :
    /succulent|aloe|agave/.test(lower) ? 'succulent' :
    /fern/.test(lower) ? 'fern' :
    /grass|reed|moss|lawn|wheat|barley|hay/.test(lower) ? 'grass' :
    /mushroom|fungus/.test(lower) ? 'mushroom' :
    /bush|shrub|hedge|holly|azalea|boxwood|tumbleweed/.test(lower) ? 'bush' :
    /flower|orchid|lily|daisy|poppy|lotus/.test(lower) ? 'flower' :
    'generic';

  const height =
    species === 'pine' ? 2.0 + rand() * 1.8 :
    species === 'palm' ? 2.2 + rand() * 1.5 :
    species === 'willow' ? 4.0 + rand() * 2.0 :
    species === 'grass' ? 0.45 + rand() * 0.45 :
    species === 'fern' ? 0.45 + rand() * 0.6 :
    species === 'mushroom' ? 0.18 + rand() * 0.3 :
    0.75 + rand() * 1.5;

  const canopyRadius =
    species === 'pine' ? height * (0.25 + rand() * 0.07) :
    species === 'palm' ? 0.65 + rand() * 0.35 :
    species === 'grass' ? 0.22 + rand() * 0.16 :
    species === 'fern' ? 0.28 + rand() * 0.22 :
    species === 'willow' ? 0.5 + rand() * 0.20 :
    species === 'mushroom' ? 0.22 + rand() * 0.18 :
    0.28 + rand() * 0.5;

  const trunkRadius =
    species === 'grass' || species === 'fern' || species === 'flower' ||
    species === 'rose' || species === 'tulip' || species === 'sunflower' ||
    species === 'mushroom'
      ? 0.025 + rand() * 0.04
      : Math.max(0.045, Math.min(0.22, height * (0.025 + rand() * 0.025)));

  const base = vegetationColor(type);
  const leafColor = base.clone()
    .offsetHSL((rand() - 0.5) * 0.06, (rand() - 0.5) * 0.16, (rand() - 0.5) * 0.12);

  const leafDark = leafColor.clone().offsetHSL(0, 0.02, -0.16);

  const bloomColor =
    /rose/.test(lower) ? new THREE.Color('#d64d6b') :
    /tulip/.test(lower) ? new THREE.Color('#e85f72') :
    /sunflower/.test(lower) ? new THREE.Color('#e4ad2c') :
    /orchid/.test(lower) ? new THREE.Color('#b879b7') :
    /lotus/.test(lower) ? new THREE.Color('#e8a9ad') :
    /daisy/.test(lower) ? new THREE.Color('#f3e6a0') :
    /poppy/.test(lower) ? new THREE.Color('#d9534f') :
    /cherry|blossom/.test(lower) ? new THREE.Color('#f0a7c4') :
    /flower/.test(lower) ? new THREE.Color('#d98ab3') :
    null;

  const trunkColor =
    species === 'palm'
      ? new THREE.Color('#80633e')
      : species === 'mushroom'
        ? new THREE.Color('#d0b092')
        : new THREE.Color('#60462f')
            .lerp(new THREE.Color('#947451'), rand() * 0.45);

  return {
    species,
    height,
    trunkRadius,
    canopyRadius,
    trunkColor,
    leafColor,
    leafDark,
    bloomColor,
    accentColor: bloomColor ?? leafDark,
    detail: 2 + Math.floor(rand() * 3),
    lean: (rand() - 0.5) * 0.18,
    asymmetry: 0.8 + rand() * 0.4,
  };
};

const paintVertexColors = (
  geometry: THREE.BufferGeometry,
  color: THREE.Color,
  variation = 0,
  seed = 1,
) => {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const rand = seededRandom(seed);

  for (let i = 0; i < count; i++) {
    const amount = variation ? (rand() - 0.5) * variation : 0;
    const c = color.clone().offsetHSL(0, 0, amount);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
};

const merge = (parts: THREE.BufferGeometry[]) => {
  const valid = parts.filter(Boolean);
  if (!valid.length) return new THREE.BufferGeometry();

  const normalized = valid.map((geometry) => {
    const clone = geometry.clone();
    clone.deleteAttribute('uv');
    clone.deleteAttribute('uv2');
    return clone;
  });

  return BufferGeometryUtils.mergeGeometries(normalized, false) as THREE.BufferGeometry;
};

const makeTrunk = (style: PlantStyle, radial = 8, color = style.trunkColor) => {
  const trunk = new THREE.CylinderGeometry(
    style.trunkRadius * 0.82,
    style.trunkRadius * 1.15,
    style.height,
    radial,
    2,
    false,
  );
  trunk.rotateZ(style.lean);
  trunk.translate(0, style.height / 2, 0);
  paintVertexColors(trunk, color, 0.08, hashString('trunk:' + style.species));
  return trunk;
};

const flowerStem = (style: PlantStyle) => {
  const stem = new THREE.CylinderGeometry(
    style.trunkRadius * 0.55,
    style.trunkRadius * 0.8,
    style.height,
    6,
    2,
    false,
  );

  const stemLean = style.lean * 0.35;

  stem.rotateZ(stemLean);
  stem.translate(
    0,
    style.height / 2,
    0,
  );

  paintVertexColors(
    stem,
    new THREE.Color('#3f793c'),
    0.08,
    hashString(
      'flower-stem:' + style.species,
    ),
  );

  return stem;
};

const createOakCanopy = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('oak:' + style.height));

  // Main branches create the characteristic tree silhouette instead of
  // putting one foliage blob directly on top of the trunk.
  const branches = 4 + style.detail;
  for (let i = 0; i < branches; i++) {
    const angle = (i / branches) * Math.PI * 2 + rand() * 0.4;
    const length = style.canopyRadius * (0.65 + rand() * 0.65);
    const branch = new THREE.CylinderGeometry(
      style.trunkRadius * 0.22,
      style.trunkRadius * 0.42,
      length,
      6,
      2,
    );
    branch.rotateZ(Math.PI / 2 + (rand() - 0.5) * 0.45);
    branch.rotateY(angle);
    branch.translate(
      Math.cos(angle) * length * 0.28,
      style.height * (0.82 + rand() * 0.12),
      Math.sin(angle) * length * 0.28,
    );
    paintVertexColors(branch, style.trunkColor, 0.06, i + 10);
    parts.push(branch);
  }

  // Broad, irregular crown sits above the branching structure.
  const clumps = 7 + style.detail;
  for (let i = 0; i < clumps; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = style.canopyRadius * (0.35 + rand() * 0.8);
    const sphere = new THREE.SphereGeometry(
      style.canopyRadius * (0.42 + rand() * 0.32),
      10,
      7,
    );
    sphere.applyMatrix4(
      new THREE.Matrix4().makeScale(
        0.95 + rand() * 0.35,
        0.65 + rand() * 0.35,
        0.9 + rand() * 0.3,
      ),
    );
    sphere.translate(
      Math.cos(angle) * radius,
      style.height * (0.82 + rand() * 0.3),
      Math.sin(angle) * radius,
    );
    paintVertexColors(
      sphere,
      i % 3 === 0 ? style.leafDark : style.leafColor,
      0.08,
      i + 30,
    );
    parts.push(sphere);
  }

  return merge(parts);
};

const createPineCanopy = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const levels = 5 + style.detail;

  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    const radius = style.canopyRadius * (1.0 - t * 0.82);
    const height = style.height * (0.55 + t * 0.55);
    const cone = new THREE.ConeGeometry(radius, style.height * 0.38, 9, 2);
    cone.translate(0, height, 0);
    cone.rotateY((i % 2) * 0.4);
    paintVertexColors(cone, i % 2 ? style.leafColor : style.leafDark, 0.05, i + 30);
    parts.push(cone);
  }
  return merge(parts);
};

const createMapleCanopy = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('maple:' + style.height));

  // Maple has a visible trunk and several upward-spreading limbs.
  const branches = 5 + style.detail;
  for (let i = 0; i < branches; i++) {
    const angle = (i / branches) * Math.PI * 2 + rand() * 0.35;
    const length = style.canopyRadius * (0.7 + rand() * 0.65);
    const branch = new THREE.CylinderGeometry(
      style.trunkRadius * 0.18,
      style.trunkRadius * 0.34,
      length,
      6,
      2,
    );
    branch.rotateZ(Math.PI / 2.35 + (rand() - 0.5) * 0.25);
    branch.rotateY(angle);
    branch.translate(
      Math.cos(angle) * length * 0.28,
      style.height * (0.68 + rand() * 0.1),
      Math.sin(angle) * length * 0.28,
    );
    paintVertexColors(branch, style.trunkColor, 0.06, i + 60);
    parts.push(branch);
  }

  // Red maple crown: broad, layered, and slightly flattened.
  const center = new THREE.SphereGeometry(style.canopyRadius * 0.72, 12, 8);
  center.applyMatrix4(new THREE.Matrix4().makeScale(1.2, 0.72, 1.08));
  center.translate(0, style.height * 0.93, 0);
  paintVertexColors(center, style.leafColor, 0.09, 80);
  parts.push(center);

  const lobes = 7 + style.detail;
  for (let i = 0; i < lobes; i++) {
    const angle = (i / lobes) * Math.PI * 2;
    const lobe = new THREE.SphereGeometry(
      style.canopyRadius * (0.36 + rand() * 0.22),
      9,
      7,
    );
    lobe.applyMatrix4(new THREE.Matrix4().makeScale(1.15, 0.7 + rand() * 0.2, 0.95));
    lobe.translate(
      Math.cos(angle) * style.canopyRadius * (0.65 + rand() * 0.15),
      style.height * (0.82 + rand() * 0.18),
      Math.sin(angle) * style.canopyRadius * (0.65 + rand() * 0.15),
    );
    paintVertexColors(
      lobe,
      i % 2 ? style.leafColor : style.leafDark,
      0.09,
      i + 90,
    );
    parts.push(lobe);
  }

  return merge(parts);
};


/**
 * Cactus: a stylized branching columnar cactus.
 *
 * A thick central trunk grows upward with a few irregular arms.
 * Arms emerge from the trunk rather than looking like separate
 * objects placed beside it.
 */
const createCactus = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('cactus:' + style.height));

  const height = style.height;
  const radius = style.canopyRadius * 0.34;

  /*
   * Creates a rounded cactus segment between two points.
   */
  const addSegment = (
    start: THREE.Vector3,
    end: THREE.Vector3,
    r: number,
    seed: number,
  ) => {
    const direction = new THREE.Vector3()
      .subVectors(end, start);

    const length = direction.length();

    const segment = new THREE.CylinderGeometry(
      r * 0.92,
      r,
      length,
      8,
      4,
    );

    // Cylinders are generated along +Y.
    const midpoint = new THREE.Vector3()
      .addVectors(start, end)
      .multiplyScalar(0.5);

    const segmentQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize(),
    );
    segment.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(segmentQuat));

    segment.translate(
      midpoint.x,
      midpoint.y,
      midpoint.z,
    );

    paintVertexColors(
      segment,
      style.leafColor,
      0.045,
      seed,
    );

    parts.push(segment);
  };

  // Main trunk.
  const trunkHeight =
    height * (0.78 + rand() * 0.15);

  const trunkTop = new THREE.Vector3(
    (rand() - 0.5) * radius * 0.5,
    trunkHeight,
    (rand() - 0.5) * radius * 0.5,
  );

  addSegment(
    new THREE.Vector3(0, 0, 0),
    trunkTop,
    radius,
    100,
  );

  /*
   * A rounded cap makes the cactus top look organic rather
   * than like a cut cylinder.
   */
  const top = new THREE.SphereGeometry(
    radius * 0.93,
    8,
    5,
  );

  top.translate(
    trunkTop.x,
    trunkTop.y,
    trunkTop.z,
  );

  paintVertexColors(
    top,
    style.leafColor,
    0.045,
    101,
  );

  parts.push(top);

  /*
   * Arms.
   *
   * Usually 2–4 arms depending on detail.
   */
  const arms = Math.max(
    1,
    Math.min(4, Math.floor(style.detail / 2) + 1),
  );

  for (let i = 0; i < arms; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const angle =
      i * Math.PI * 0.72 +
      (rand() - 0.5) * 0.45;

    const attachT =
      0.34 +
      rand() * 0.38;

    const attach = new THREE.Vector3(
      trunkTop.x * attachT,
      trunkHeight * attachT,
      trunkTop.z * attachT,
    );

    const armHeight =
      height * (0.25 + rand() * 0.20);

    const horizontal =
      radius * (1.7 + rand() * 1.3);

    /*
     * First part travels sideways.
     */
    const elbow = new THREE.Vector3(
      attach.x +
        Math.cos(angle) * horizontal,
      attach.y +
        armHeight * 0.18,
      attach.z +
        Math.sin(angle) * horizontal,
    );

    addSegment(
      attach,
      elbow,
      radius * (0.72 + rand() * 0.10),
      200 + i * 10,
    );

    /*
     * Then the arm turns upward.
     */
    const armTop = elbow.clone();

    armTop.y += armHeight * 0.72;

    addSegment(
      elbow,
      armTop,
      radius * (0.68 + rand() * 0.08),
      201 + i * 10,
    );

    const cap = new THREE.SphereGeometry(
      radius * 0.68,
      7,
      4,
    );

    cap.translate(
      armTop.x,
      armTop.y,
      armTop.z,
    );

    paintVertexColors(
      cap,
      style.leafColor,
      0.045,
      202 + i * 10,
    );

    parts.push(cap);
  }

  return merge(parts);
};

const createCactusCanopy = createCactus;



/**
 * Willow: a tall, dense weeping willow.
 *
 * The trunk rises well above the ground before branching.
 * Numerous long branches spread from the upper trunk, arc outward,
 * and then cascade downward. Dense clusters of narrow leaves follow
 * those branches to create a thick hanging canopy.
 */
const createWillow = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('willow:' + style.height));

  
  const height = style.height;
  const radius = style.canopyRadius;

  /*
   * Adds a tapered curved branch as a chain of short cylinders.
   */
  const addBranch = (
    points: THREE.Vector3[],
    startRadius: number,
    seed: number,
  ) => {
    for (let i = 0; i < points.length - 1; i++) {
      const t = i / (points.length - 1);

      const r = Math.max(
        startRadius * Math.pow(1 - t, 0.72),
        0.006,
      );

      const direction = new THREE.Vector3()
        .subVectors(
          points[i + 1],
          points[i],
        );

      const length = direction.length();

      const branch = new THREE.CylinderGeometry(
        r * 0.62,
        r,
        length,
        6,
        2,
      );

      const branchQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.clone().normalize(),
      );
      branch.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(branchQuat));

      const midpoint = new THREE.Vector3()
        .addVectors(
          points[i],
          points[i + 1],
        )
        .multiplyScalar(0.5);

      branch.translate(
        midpoint.x,
        midpoint.y,
        midpoint.z,
      );

      paintVertexColors(
        branch,
        style.leafDark,
        0.035,
        seed + i,
      );

      parts.push(branch);
    }
  };

  /*
   * ------------------------------------------------------------
   * TRUNK
   * ------------------------------------------------------------
   *
   * A tall trunk is important here. The canopy should begin
   * well above the ground rather than looking like a bush.
   */
  const trunkHeight = height * 0.62;

  const trunk = new THREE.CylinderGeometry(
    radius * 0.16,
    radius * 0.23,
    trunkHeight,
    9,
    6,
  );

  trunk.translate(
    0,
    trunkHeight * 0.5,
    0,
  );

  paintVertexColors(
    trunk,
    style.leafDark,
    0.035,
    500,
  );

  parts.push(trunk);

  /*
   * ------------------------------------------------------------
   * MAIN WEEPING BRANCHES
   * ------------------------------------------------------------
   *
   * Start them high on the trunk and make them much longer
   * than before. The outer half of each branch is deliberately
   * allowed to fall vertically.
   */
  const mainBranches =
    12 + style.detail * 3;

  for (let i = 0; i < mainBranches; i++) {
    const angle =
      (i / mainBranches) * Math.PI * 2 +
      (rand() - 0.5) * 0.28;

    // Keep the branch origins high.
    const branchHeight =
      trunkHeight *
      (0.72 + rand() * 0.25);

    // Broad canopy.
    const spread =
      radius *
      (0.95 + rand() * 0.75);

    // Long downward curtain.
    const drop =
      height *
      (0.38 + rand() * 0.28);

    const points: THREE.Vector3[] = [];
    const segments = 9;

    for (let s = 0; s <= segments; s++) {
      const t = s / segments;

      /*
       * Spread outward first, then stop spreading so the
       * branch becomes a hanging curtain.
       */
      const outward =
        spread *
        Math.sin(
          t * Math.PI * 0.52,
        );

      /*
       * The first part stays relatively high.
       * The downward movement becomes much stronger toward
       * the outer end.
       */
      const downward =
        drop *
        Math.pow(t, 1.75);

      const x =
        Math.cos(angle) * outward;

      const z =
        Math.sin(angle) * outward;

      const y =
        branchHeight -
        downward;

      points.push(
        new THREE.Vector3(
          x,
          Math.max(y, height * 0.08),
          z,
        ),
      );
    }

    addBranch(
      points,
      radius * (0.045 + rand() * 0.022),
      600 + i * 30,
    );

    /*
     * --------------------------------------------------------
     * SECONDARY HANGING BRANCHES
     * --------------------------------------------------------
     *
     * Several secondary branches come off every major branch.
     * These are what make the canopy thick instead of sparse.
     */
    const secondaryCount =
      4 + Math.floor(rand() * 3);

    for (let j = 0; j < secondaryCount; j++) {
      const t =
        0.18 +
        rand() * 0.70;

      const index = Math.min(
        segments - 2,
        Math.floor(t * segments),
      );

      const origin = points[index].clone();

      const localAngle =
        angle +
        (rand() - 0.5) * 1.15;

      const branchLength =
        radius *
        (0.45 + rand() * 0.65);

      const secondaryDrop =
        height *
        (0.16 + rand() * 0.17);

      const p1 = origin.clone();

      const p2 = origin.clone().add(
        new THREE.Vector3(
          Math.cos(localAngle) *
            branchLength * 0.55,
          secondaryDrop * 0.12,
          Math.sin(localAngle) *
            branchLength * 0.55,
        ),
      );

      const p3 = origin.clone().add(
        new THREE.Vector3(
          Math.cos(localAngle) *
            branchLength,
          -secondaryDrop * 0.40,
          Math.sin(localAngle) *
            branchLength,
        ),
      );

      const p4 = origin.clone().add(
        new THREE.Vector3(
          Math.cos(localAngle) *
            branchLength * 1.05,
          -secondaryDrop,
          Math.sin(localAngle) *
            branchLength * 1.05,
        ),
      );

      addBranch(
        [p1, p2, p3, p4],
        radius * (0.018 + rand() * 0.012),
        800 + i * 50 + j * 10,
      );

      /*
       * ------------------------------------------------------
       * LEAVES ALONG THIS SECONDARY BRANCH
       * ------------------------------------------------------
       *
       * Instead of scattering leaves randomly in space, put
       * them directly along the branch. This gives the canopy
       * real hanging structure.
       */
      const leavesOnTwig =
        5 + Math.floor(rand() * 4);

      for (let k = 0; k < leavesOnTwig; k++) {
        const leafT =
          0.08 +
          (k / leavesOnTwig) * 0.92;

        // Interpolate along the twig.
        const branchPos =
          p2.clone().lerp(
            p4,
            leafT,
          );

        /*
         * Add a small amount of randomness around the twig
         * so the leaves don't form a perfect row.
         */
        branchPos.x +=
          (rand() - 0.5) * radius * 0.08;

        branchPos.y +=
          (rand() - 0.5) * radius * 0.10;

        branchPos.z +=
          (rand() - 0.5) * radius * 0.08;

        const leafLength =
          radius *
          (0.11 + rand() * 0.075);

        const leafWidth =
          leafLength *
          (0.20 + rand() * 0.12);

        const leaf = new THREE.ConeGeometry(
          leafWidth,
          leafLength,
          5,
          1,
        );

        /*
         * Make the leaves narrow and blade-like.
         */
        leaf.applyMatrix4(
          new THREE.Matrix4().makeScale(
            1,
            1,
            0.30,
          ),
        );

        /*
         * Willow leaves hang mostly downward, but vary enough
         * to keep the canopy natural.
         */
        leaf.rotateZ(
          (rand() - 0.5) * 0.55,
        );

        leaf.rotateX(
          Math.PI * 0.45 +
          (rand() - 0.5) * 0.30,
        );

        leaf.rotateY(
          localAngle +
          (rand() - 0.5) * 0.9,
        );

        leaf.translate(
          branchPos.x,
          branchPos.y,
          branchPos.z,
        );

        paintVertexColors(
          leaf,
          k % 5 === 0
            ? style.leafDark
            : style.leafColor,
          0.075,
          1200 + i * 100 + j * 10 + k,
        );

        parts.push(leaf);
      }
    }
  }

  /*
   * ------------------------------------------------------------
   * EXTRA OUTER CURTAINS
   * ------------------------------------------------------------
   *
   * These extra thin branches fill the silhouette between the
   * major branches and make the willow look dense.
   */
  const curtainCount =
    10 + style.detail * 2;

  for (let i = 0; i < curtainCount; i++) {
    const angle =
      rand() * Math.PI * 2;

    const startHeight =
      height *
      (0.52 + rand() * 0.32);

    const spread =
      radius *
      (0.55 + rand() * 0.85);

    const drop =
      height *
      (0.28 + rand() * 0.25);

    const points: THREE.Vector3[] = [];

    for (let s = 0; s <= 5; s++) {
      const t = s / 5;

      const outward =
        spread *
        Math.sin(t * Math.PI * 0.5);

      const y =
        startHeight -
        drop * Math.pow(t, 1.5);

      points.push(
        new THREE.Vector3(
          Math.cos(angle) * outward,
          y,
          Math.sin(angle) * outward,
        ),
      );
    }

    addBranch(
      points,
      radius * 0.022,
      1500 + i * 10,
    );
  }

  return merge(parts);
};



const createPalmCanopy = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('palm:' + style.height));
  const fronds = 8 + style.detail;

  for (let i = 0; i < fronds; i++) {
    const angle = (i / fronds) * Math.PI * 2;
    const length = style.canopyRadius * (1.1 + rand() * 0.6);
    const frond = new THREE.ConeGeometry(style.canopyRadius * 0.13, length, 5, 2);
    frond.applyMatrix4(new THREE.Matrix4().makeScale(0.35, 1, 1));
    frond.rotateZ(-Math.PI / 2.8);
    frond.rotateY(angle);
    frond.translate(
      Math.cos(angle) * length * 0.35,
      style.height + 0.1 + rand() * 0.15,
      Math.sin(angle) * length * 0.35,
    );
    paintVertexColors(frond, i % 2 ? style.leafColor : style.leafDark, 0.08, i + 110);
    parts.push(frond);
  }

  // Palm trunk rings add a recognizable silhouette without requiring textures.
  for (let i = 0; i < 5; i++) {
    const ring = new THREE.TorusGeometry(
      style.trunkRadius * 1.05,
      style.trunkRadius * 0.06,
      4,
      8,
    );
    ring.rotateX(Math.PI / 2);
    ring.translate(0, style.height * (0.15 + i * 0.16), 0);
    paintVertexColors(ring, style.trunkColor, 0.04, i + 130);
    parts.push(ring);
  }

  return merge(parts);
};




// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const petalColor = (style: PlantStyle, fallback: string) =>
  style.bloomColor ?? new THREE.Color(fallback);

const makePetal = (
  radius: number,
  width: number,
  height: number,
  color: THREE.Color,
  seed: number,
) => {
  // A sphere is used as the base, but heavily stretched so the result
  // behaves more like a soft, organic petal.
  const petal = new THREE.SphereGeometry(radius, 10, 6);

  petal.applyMatrix4(
    new THREE.Matrix4().makeScale(
      width,
      height,
      radius * 0.9,
    ),
  );

  paintVertexColors(petal, color, 0.07, seed);
  return petal;
};



// -----------------------------------------------------------------------------
// FLOWER HEAD POSITION
// -----------------------------------------------------------------------------
//
// flowerStem() is created like this:
//
//   stem.rotateZ(style.lean * 0.35);
//   stem.translate(0, style.height / 2, 0);
//
// The cylinder itself is centered around Y = 0, so its top is initially:
//
//   (0, style.height / 2, 0)
//
// After rotateZ(), that top point moves sideways.
//
// We calculate that exact point here so the flower head is centered on the
// actual top of the stem.
//
// IMPORTANT:
// Flower geometry is already Y-up. Do NOT rotate the flower head around X.
// -----------------------------------------------------------------------------

const getFlowerBase = (style: PlantStyle) => {
  const stemLean = style.lean * 0.35;
  const halfHeight = style.height / 2;

  return {
    x: -Math.sin(stemLean) * halfHeight,
    y: halfHeight,
    z: 0,
  };
};

// -----------------------------------------------------------------------------
// GENERIC FLOWER
// -----------------------------------------------------------------------------

const createFlowerHead = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];

  const bloom =
    style.bloomColor ?? style.accentColor;

  const r = style.canopyRadius;
  const base = getFlowerBase(style);
  const petalCount = 7 + style.detail;

  // Outer petals -------------------------------------------------------------

  for (let i = 0; i < petalCount; i++) {
    const angle =
      (i / petalCount) * Math.PI * 2;

    const petal = new THREE.SphereGeometry(
      r * 0.48,
      10,
      6,
    );

    petal.applyMatrix4(
      new THREE.Matrix4().makeScale(
        1.45,
        0.20,
        0.85,
      ),
    );

    petal.rotateY(-angle);
    petal.rotateX(-0.15);
    petal.translate(
      base.x + Math.cos(angle) * r * 0.38,
      base.y + r * 0.48,
      base.z + Math.sin(angle) * r * 0.38,
    );

    paintVertexColors(
      petal,
      bloom,
      0.07,
      180 + i,
    );

    parts.push(petal);
  }

  // Inner petals -------------------------------------------------------------

  const innerCount = Math.max(
    5,
    Math.floor(petalCount * 0.65),
  );

  for (let i = 0; i < innerCount; i++) {
    const angle =
      (i / innerCount) * Math.PI * 2 +
      Math.PI / innerCount;

    const petal = new THREE.SphereGeometry(
      r * 0.31,
      9,
      6,
    );

    petal.applyMatrix4(
      new THREE.Matrix4().makeScale(
        1.25,
        0.23,
        0.78,
      ),
    );

    petal.rotateY(-angle);
    petal.rotateX(-0.28);
    petal.translate(
      base.x + Math.cos(angle) * r * 0.17,
      base.y + r * 0.61,
      base.z + Math.sin(angle) * r * 0.17,
    );

    paintVertexColors(
      petal,
      bloom,
      0.06,
      240 + i,
    );

    parts.push(petal);
  }

  // Center -------------------------------------------------------------------

  const center = new THREE.SphereGeometry(
    r * 0.18,
    14,
    10,
  );

  center.scale(1, 0.65, 1);

  center.translate(
    base.x,
    base.y + r * 0.67,
    base.z,
  );

  paintVertexColors(
    center,
    new THREE.Color('#e0a83d'),
    0.08,
    300,
  );

  parts.push(center);

  // Calyx --------------------------------------------------------------------

  const calyx = new THREE.ConeGeometry(
    r * 0.22,
    r * 0.30,
    7,
    1,
  );

  calyx.translate(
    base.x,
    base.y + r * 0.15,
    base.z,
  );

  paintVertexColors(
    calyx,
    new THREE.Color('#3f793c'),
    0.06,
    301,
  );

  parts.push(calyx);

  return merge(parts);
};


const createSunflowerHead = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];

  const bloom = style.bloomColor ?? style.accentColor;
  const r = style.canopyRadius;

  const base = getFlowerBase(style);

  // ---------------------------------------------------------------------------
  // FLOWER POSITION
  //
  // Y = vertical
  // Z = forward/back
  //
  // The flower should sit at the very top of the stem.
  //
  // If getFlowerBase() already returns the TOP of the stem, keep this at 0.
  // If it returns the bottom/center of the stem, increase this offset to
  // match your stem height.
  // ---------------------------------------------------------------------------

  const stemTopY = base.y + r * 2.5;

  const headCenter = {
    x: base.x,
    y: stemTopY,
    z: base.z,
  };

  const petalCount = 18;

  // ---------------------------------------------------------------------------
  // OUTER PETALS
  //
  // The flower is vertical, so petals spread around X/Y.
  // Z is their thickness/depth.
  // ---------------------------------------------------------------------------

  for (let i = 0; i < petalCount; i++) {
    const angle =
      (i / petalCount) * Math.PI * 2;

    const petal = new THREE.SphereGeometry(
      r * 0.48,
      10,
      6,
    );

    // X = width
    // Y = radial length
    // Z = thickness
    petal.applyMatrix4(
      new THREE.Matrix4().makeScale(
        0.62,
        1.45,
        0.20,
      ),
    );

    // Spread around the vertical axis.
    petal.rotateZ(angle);

    // Slightly droop the petals.
    petal.rotateX(0.08);

    const petalDistance = r * 0.39;

    petal.translate(
      headCenter.x +
        Math.cos(angle) * petalDistance,
      headCenter.y +
        Math.sin(angle) * petalDistance,
      headCenter.z,
    );

    paintVertexColors(
      petal,
      bloom,
      0.055,
      180 + i,
    );

    parts.push(petal);
  }

  // ---------------------------------------------------------------------------
  // INNER PETALS
  // ---------------------------------------------------------------------------

  const innerPetalCount = 14;

  for (let i = 0; i < innerPetalCount; i++) {
    const angle =
      (i / innerPetalCount) * Math.PI * 2 +
      Math.PI / innerPetalCount;

    const petal = new THREE.SphereGeometry(
      r * 0.32,
      9,
      6,
    );

    petal.applyMatrix4(
      new THREE.Matrix4().makeScale(
        0.58,
        1.20,
        0.18,
      ),
    );

    petal.rotateZ(angle);

    const petalDistance = r * 0.19;

    petal.translate(
      headCenter.x +
        Math.cos(angle) * petalDistance,
      headCenter.y +
        Math.sin(angle) * petalDistance,
      headCenter.z + r * 0.015,
    );

    paintVertexColors(
      petal,
      bloom,
      0.045,
      230 + i,
    );

    parts.push(petal);
  }

  // ---------------------------------------------------------------------------
  // LARGE BROWN CENTER
  //
  // This is the main sunflower face.
  // It is deliberately large and clearly visible.
  //
  // CircleGeometry starts in XY, which is exactly what we want:
  // a vertical disk facing +Z.
  // ---------------------------------------------------------------------------

  const center = new THREE.CircleGeometry(
    r * 0.30,
    32,
  );

  center.translate(
    headCenter.x,
    headCenter.y,
    headCenter.z + r * 0.13,
  );

  paintVertexColors(
    center,
    new THREE.Color('#5a3215'),
    0.025,
    300,
  );

  parts.push(center);

  // ---------------------------------------------------------------------------
  // ROUNDED BROWN BACKING
  //
  // Gives the center actual 3D depth instead of looking like a flat decal.
  // ---------------------------------------------------------------------------

  const centerVolume = new THREE.SphereGeometry(
    r * 0.31,
    18,
    12,
  );

  centerVolume.scale(
    1,
    1,
    0.18,
  );

  centerVolume.translate(
    headCenter.x,
    headCenter.y,
    headCenter.z + r * 0.07,
  );

  paintVertexColors(
    centerVolume,
    new THREE.Color('#633816'),
    0.045,
    310,
  );

  parts.push(centerVolume);

  // ---------------------------------------------------------------------------
  // DARK INNER CIRCLE
  //
  // Makes the brown center much more obvious.
  // ---------------------------------------------------------------------------

  const innerCircle = new THREE.CircleGeometry(
    r * 0.235,
    28,
  );

  innerCircle.translate(
    headCenter.x,
    headCenter.y,
    headCenter.z + r * 0.145,
  );

  paintVertexColors(
    innerCircle,
    new THREE.Color('#351b0b'),
    0.02,
    320,
  );

  parts.push(innerCircle);

  // ---------------------------------------------------------------------------
  // SEEDS
  //
  // Small raised brown/gold dots give the center sunflower texture.
  // ---------------------------------------------------------------------------

  const seedCount = 45;

  for (let i = 0; i < seedCount; i++) {
    const angle = i * 2.39996323;

    const radius =
      Math.sqrt((i + 0.5) / seedCount) *
      r *
      0.20;

    const seed = new THREE.SphereGeometry(
      r * 0.025,
      6,
      4,
    );

    seed.scale(
      1,
      1,
      0.35,
    );

    seed.translate(
      headCenter.x +
        Math.cos(angle) * radius,
      headCenter.y +
        Math.sin(angle) * radius,
      headCenter.z + r * 0.165,
    );

    paintVertexColors(
      seed,
      i % 3 === 0
        ? new THREE.Color('#a2672a')
        : new THREE.Color('#714018'),
      0.02,
      340 + i,
    );

    parts.push(seed);
  }


  // ---------------------------------------------------------------------------
  // GREEN COLLAR
  // ---------------------------------------------------------------------------

  const collar = new THREE.SphereGeometry(
    r * 0.20,
    10,
    6,
  );

  collar.scale(
    1,
    0.55,
    1,
  );

  collar.translate(
    headCenter.x,
    headCenter.y - r * 0.12,
    headCenter.z,
  );

  paintVertexColors(
    collar,
    new THREE.Color('#477f3b'),
    0.04,
    420,
  );

  parts.push(collar);

  return merge(parts);
};



// -----------------------------------------------------------------------------
// TULIP
// -----------------------------------------------------------------------------

const createTulip = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];

  const bloom =
    style.bloomColor ??
    new THREE.Color('#e85f72');

  const r = style.canopyRadius;
  const base = getFlowerBase(style);

  // Six petals arranged around the stem centerline.
  for (let i = 0; i < 6; i++) {
    const angle =
      (i / 6) * Math.PI * 2;

    const petal = new THREE.SphereGeometry(
      r * 0.46,
      10,
      8,
    );

    petal.applyMatrix4(
      new THREE.Matrix4().makeScale(
        0.65,
        1.45,
        0.40,
      ),
    );

    petal.rotateY(angle);

    // Petals lean outward while their bottoms remain over the stem.
    petal.rotateX(-0.22);

    petal.translate(
      base.x + Math.cos(angle) * r * 0.20,
      base.y + r * 0.55,
      base.z + Math.sin(angle) * r * 0.20,
    );

    paintVertexColors(
      petal,
      bloom,
      0.055,
      400 + i,
    );

    parts.push(petal);
  }

  // Interior of the cup.
  const inner = new THREE.SphereGeometry(
    r * 0.38,
    12,
    8,
  );

  inner.scale(
    0.9,
    0.8,
    0.9,
  );

  inner.translate(
    base.x,
    base.y + r * 0.60,
    base.z,
  );

  paintVertexColors(
    inner,
    bloom.clone().multiplyScalar(0.78),
    0.045,
    420,
  );

  parts.push(inner);

  // Calyx directly above stem.
  const calyx = new THREE.ConeGeometry(
    r * 0.23,
    r * 0.30,
    6,
    1,
  );

  calyx.translate(
    base.x,
    base.y + r * 0.15,
    base.z,
  );

  paintVertexColors(
    calyx,
    new THREE.Color('#3f793c'),
    0.05,
    421,
  );

  parts.push(calyx);

  return merge(parts);
};

// -----------------------------------------------------------------------------
// ROSE
// -----------------------------------------------------------------------------

const createRose = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];

  const bloom =
    style.bloomColor ??
    new THREE.Color('#d64d6b');

  const r = style.canopyRadius;
  const base = getFlowerBase(style);

  // Outer petals -------------------------------------------------------------

  const outerLayers =
    3 + Math.min(style.detail, 3);

  for (let layer = 0; layer < outerLayers; layer++) {
    const count =
      Math.max(6, 9 - layer);

    for (let i = 0; i < count; i++) {
      const angle =
        (i / count) * Math.PI * 2 +
        layer * 0.52;

      const petal =
        new THREE.SphereGeometry(
          r * (0.25 - layer * 0.018),
          9,
          6,
        );

      petal.applyMatrix4(
        new THREE.Matrix4().makeScale(
          1.45,
          0.22,
          0.92,
        ),
      );

      petal.rotateY(-angle);

      // Outer petals open outward from the stem.
      petal.rotateX(
        0.24 + layer * 0.08,
      );

      petal.translate(
        base.x +
          Math.cos(angle) *
            r *
            (0.20 + layer * 0.075),

        base.y +
          r *
          (0.47 + layer * 0.045),

        base.z +
          Math.sin(angle) *
            r *
            (0.20 + layer * 0.075),
      );

      paintVertexColors(
        petal,
        bloom,
        0.065,
        500 + layer * 20 + i,
      );

      parts.push(petal);
    }
  }

  // Inner spiral -------------------------------------------------------------

  const innerLayers =
    4 + Math.min(style.detail, 2);

  for (
    let layer = 0;
    layer < innerLayers;
    layer++
  ) {
    const count = 5;

    for (let i = 0; i < count; i++) {
      const angle =
        (i / count) * Math.PI * 2 +
        layer * 0.85;

      const radius =
        r * (0.17 - layer * 0.022);

      const petal =
        new THREE.SphereGeometry(
          r * (0.15 - layer * 0.012),
          8,
          6,
        );

      petal.applyMatrix4(
        new THREE.Matrix4().makeScale(
          1.25,
          0.30,
          0.72,
        ),
      );

      petal.rotateY(-angle);

      petal.rotateX(
        -0.30 + layer * 0.08,
      );

      petal.translate(
        base.x +
          Math.cos(angle) * radius,

        base.y +
          r *
          (0.62 + layer * 0.025),

        base.z +
          Math.sin(angle) * radius,
      );

      paintVertexColors(
        petal,
        bloom.clone().multiplyScalar(
          0.90 + layer * 0.025,
        ),
        0.055,
        600 + layer * 10 + i,
      );

      parts.push(petal);
    }
  }

  // Rose center --------------------------------------------------------------

  const center =
    new THREE.SphereGeometry(
      r * 0.10,
      8,
      6,
    );

  center.scale(
    0.9,
    1.25,
    0.9,
  );

  center.translate(
    base.x,
    base.y + r * 0.70,
    base.z,
  );

  paintVertexColors(
    center,
    bloom.clone().multiplyScalar(0.82),
    0.04,
    700,
  );

  parts.push(center);

  // Calyx directly over stem.
  const calyx = new THREE.ConeGeometry(
    r * 0.24,
    r * 0.30,
    7,
    1,
  );

  calyx.translate(
    base.x,
    base.y + r * 0.15,
    base.z,
  );

  paintVertexColors(
    calyx,
    new THREE.Color('#376d37'),
    0.05,
    701,
  );

  parts.push(calyx);

  return merge(parts);
};

// -----------------------------------------------------------------------------
// FERN
// -----------------------------------------------------------------------------

const createFern = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(
    hashString('fern:' + style.height),
  );

  const blades =
    7 + style.detail * 2;

  for (let i = 0; i < blades; i++) {
    const angle =
      (i / blades) * Math.PI * 2;

    const length =
      style.height *
      (0.8 + rand() * 0.45);

    const blade =
      new THREE.ConeGeometry(
        style.canopyRadius * 0.18,
        length,
        5,
        3,
      );

    blade.applyMatrix4(
      new THREE.Matrix4().makeScale(
        0.25,
        1,
        0.8,
      ),
    );

    blade.rotateZ(-Math.PI / 3.2);
    blade.rotateY(angle);

    blade.translate(
      Math.cos(angle) *
        length *
        0.25,
      length * 0.42,
      Math.sin(angle) *
        length *
        0.25,
    );

    paintVertexColors(
      blade,
      i % 2
        ? style.leafColor
        : style.leafDark,
      0.1,
      i + 240,
    );

    parts.push(blade);
  }

  return merge(parts);
};

// -----------------------------------------------------------------------------
// GRASS
// -----------------------------------------------------------------------------

const createGrass = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(
    hashString('grass:' + style.height),
  );

  const blades =
    9 + style.detail * 3;

  for (let i = 0; i < blades; i++) {
    const angle =
      rand() * Math.PI * 2;

    const radius =
      Math.sqrt(rand()) *
      style.canopyRadius;

    const blade =
      new THREE.ConeGeometry(
        0.055,
        style.height *
          (0.75 + rand() * 0.5),
        4,
        1,
      );

    blade.rotateZ(
      (rand() - 0.5) * 0.45,
    );

    blade.rotateY(angle);

    blade.translate(
      Math.cos(angle) * radius,
      style.height * 0.4,
      Math.sin(angle) * radius,
    );

    paintVertexColors(
      blade,
      i % 2
        ? style.leafColor
        : style.leafDark,
      0.12,
      i + 260,
    );

    parts.push(blade);
  }

  return merge(parts);
};

// -----------------------------------------------------------------------------
// BUSH
// -----------------------------------------------------------------------------

const createBush = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(
    hashString('bush:' + style.height),
  );

  const clumps =
    5 + style.detail;

  for (let i = 0; i < clumps; i++) {
    const angle =
      rand() * Math.PI * 2;

    const radius =
      Math.sqrt(rand()) *
      style.canopyRadius *
      0.55;

    const sphere =
      new THREE.SphereGeometry(
        style.canopyRadius *
          (0.45 + rand() * 0.35),
        9,
        7,
      );

    sphere.applyMatrix4(
      new THREE.Matrix4().makeScale(
        1 + rand() * 0.25,
        0.7 + rand() * 0.35,
        0.9 + rand() * 0.25,
      ),
    );

    sphere.translate(
      Math.cos(angle) * radius,
      style.height * 0.55 +
        rand() *
          style.canopyRadius *
          0.35,
      Math.sin(angle) * radius,
    );

    paintVertexColors(
      sphere,
      i % 2
        ? style.leafColor
        : style.leafDark,
      0.09,
      i + 280,
    );

    parts.push(sphere);
  }

  return merge(parts);
};

// -----------------------------------------------------------------------------
// MUSHROOM
// -----------------------------------------------------------------------------

const createMushroom = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];

  const stem =
    new THREE.CapsuleGeometry(
      style.trunkRadius * 0.75,
      style.height * 0.55,
      4,
      7,
    );

  stem.translate(
    0,
    style.height * 0.3,
    0,
  );

  paintVertexColors(
    stem,
    style.trunkColor,
    0.06,
    300,
  );

  parts.push(stem);

  const cap =
    new THREE.SphereGeometry(
      style.canopyRadius,
      12,
      7,
      0,
      Math.PI * 2,
      0,
      Math.PI / 2,
    );

  cap.applyMatrix4(
    new THREE.Matrix4().makeScale(
      1.15,
      0.55,
      1.15,
    ),
  );

  cap.translate(
    0,
    style.height * 0.72,
    0,
  );

  paintVertexColors(
    cap,
    new THREE.Color('#9b5b45'),
    0.08,
    301,
  );

  parts.push(cap);

  return merge(parts);
};



/**
 * Agave: a compact rosette of thick, pointed leaves.
 *
 * Every leaf begins at the same central growing point, rises upward,
 * then sweeps outward. Outer leaves become more horizontal, while
 * inner leaves remain more upright.
 */
const createAgave = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('agave:' + style.height));

  const leaves = 14 + style.detail * 3;
  const radius = style.canopyRadius;

  for (let i = 0; i < leaves; i++) {
    const angle =
      (i / leaves) * Math.PI * 2 +
      (rand() - 0.5) * 0.14;

    const length = radius * (1.35 + rand() * 0.8);
    const width = radius * (0.14 + rand() * 0.07);

    const segments = 7;
    const vertices: number[] = [];
    const indices: number[] = [];

    // Inner leaves stand more upright.
    // Outer leaves spread farther horizontally.
    const spread = 0.72 + rand() * 0.18;
    const rise = 0.62 + rand() * 0.18;

    for (let s = 0; s <= segments; s++) {
      const t = s / segments;

      // Width is broad near the base and narrows to a sharp tip.
      const w =
        width *
        Math.pow(1 - t, 0.68);

      /*
       * Horizontal distance from the centre.
       *
       * Starts at zero and accelerates outward toward the tip.
       */
      const outward =
        length *
        spread *
        Math.pow(t, 1.35);

      /*
       * Height above the central growing point.
       *
       * The leaf rises quickly near the base, then levels off.
       *
       * At t = 0:
       *   y = 0
       *
       * At t = 1:
       *   y is still positive
       *
       * This is what keeps the tips from pointing downward.
       */
      const upward =
        length *
        rise *
        (
          0.20 * t +
          0.80 * Math.sin(t * Math.PI * 0.55)
        );

      // Very subtle natural bend.
      const bend =
        Math.sin(t * Math.PI) *
        length *
        0.025;

      const x = Math.cos(angle) * outward;
      const z = Math.sin(angle) * outward;

      // Perpendicular horizontal vector for leaf width.
      const sideX = -Math.sin(angle);
      const sideZ = Math.cos(angle);

      /*
       * Two sides of the blade.
       *
       * Both start at exactly the same central point, so all
       * leaves visually emerge from one rosette centre.
       */
      vertices.push(
        x + sideX * w,
        upward,
        z + sideZ * w,

        x - sideX * w,
        upward,
        z - sideZ * w,
      );
    }

    for (let s = 0; s < segments; s++) {
      const a = s * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;

      indices.push(
        a, c, b,
        b, c, d,
      );
    }

    const leaf = new THREE.BufferGeometry();

    leaf.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices, 3),
    );

    leaf.setIndex(indices);
    leaf.computeVertexNormals();

    paintVertexColors(
      leaf,
      i % 3 === 0
        ? style.leafDark
        : style.leafColor,
      0.065,
      i + 400,
    );

    parts.push(leaf);
  }

  /*
   * Small central growth point.
   *
   * Keep this much smaller than the old sphere so the leaves
   * clearly read as individual blades rather than a green mound.
   */
  const core = new THREE.SphereGeometry(
    radius * 0.20,
    8,
    5,
  );

  core.applyMatrix4(
    new THREE.Matrix4().makeScale(
      1,
      0.7,
      1,
    ),
  );

  core.translate(
    0,
    radius * 0.08,
    0,
  );

  paintVertexColors(
    core,
    style.leafDark,
    0.05,
    450,
  );

  parts.push(core);

  return merge(parts);
};



/**
 * Tumbleweed: an airy, almost spherical bundle of many thin branching stems.
 * It intentionally has a lot of empty space, unlike a solid bush.
 */
const createTumbleweed = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('tumbleweed:' + style.height));
  const branches = 22 + style.detail * 8;

  for (let i = 0; i < branches; i++) {
    const theta = Math.acos(2 * rand() - 1);
    const phi = rand() * Math.PI * 2;
    const direction = new THREE.Vector3(
      Math.sin(theta) * Math.cos(phi),
      Math.cos(theta),
      Math.sin(theta) * Math.sin(phi),
    );

    const length = style.canopyRadius * (0.55 + rand() * 0.75);
    const stem = new THREE.CylinderGeometry(
      0.018 + rand() * 0.018,
      0.025 + rand() * 0.025,
      length,
      5,
      1,
    );

    const stemQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    stem.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(stemQuat));
    stem.translate(
      direction.x * length * 0.22,
      style.canopyRadius + direction.y * length * 0.22,
      direction.z * length * 0.22,
    );

    paintVertexColors(
      stem,
      i % 3 === 0 ? new THREE.Color('#ad9568') : style.leafColor,
      0.12,
      i + 500,
    );
    parts.push(stem);

    // Small secondary twigs give the silhouette its tangled appearance.
    if (i % 2 === 0) {
      const twig = new THREE.CylinderGeometry(0.012, 0.018, length * 0.55, 4, 1);
      const twigDir = direction.clone().applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        (rand() - 0.5) * 1.8,
      ).normalize();

      const twigQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), twigDir);
      twig.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(twigQuat));
      twig.translate(
        direction.x * length * 0.35,
        style.canopyRadius + direction.y * length * 0.35,
        direction.z * length * 0.35,
      );
      paintVertexColors(twig, style.leafDark, 0.1, i + 550);
      parts.push(twig);
    }
  }

  return merge(parts);
};

/**
 * Orchid: broad green leaves at the base with an upright green stem and
 * several distinctly open orchid blossoms. Each blossom has broad petals,
 * lateral petals, and a contrasting lip.
 */
const createOrchid = (style: PlantStyle) => {
  const parts: THREE.BufferGeometry[] = [];
  const rand = seededRandom(hashString('orchid:' + style.height));
  const green = new THREE.Color('#477b43');
  const darkGreen = new THREE.Color('#315f39');
  const bloom = new THREE.Color('#8a1c1c');
  const lip = new THREE.Color('#5d1b1b');

  // Broad leaves emerge from the base, rather than using a brown trunk.
  const leaves = 5 + style.detail;
  for (let i = 0; i < leaves; i++) {
    const angle = (i / leaves) * Math.PI * 2;
    const length = 0.45 + rand() * 0.3;
    const leaf = new THREE.SphereGeometry(0.22, 8, 5);
    leaf.applyMatrix4(new THREE.Matrix4().makeScale(0.45, length * 2.0, 0.12));
    leaf.rotateZ(-Math.PI / 2.1);
    leaf.rotateY(angle);
    leaf.translate(
      Math.cos(angle) * 0.18,
      length * 0.32,
      Math.sin(angle) * 0.18,
    );
    paintVertexColors(leaf, i % 2 ? green : darkGreen, 0.08, i + 600);
    parts.push(leaf);
  }

  // Slender flowering stalk.
  const stem = new THREE.CylinderGeometry(0.025, 0.04, style.height * 0.72, 6, 2);
  stem.translate(0, style.height * 0.42, 0);
  paintVertexColors(stem, green, 0.06, 620);
  parts.push(stem);

  // Open blossoms arranged along the upper stalk.
  const flowerCount = 3 + style.detail;
  for (let f = 0; f < flowerCount; f++) {
    const y = style.height * (0.55 + (f / Math.max(1, flowerCount - 1)) * 0.42);
    const side = f % 2 === 0 ? -1 : 1;
    const x = side * (0.08 + rand() * 0.09);

    // Five broad, outward-facing petals.
    for (let p = 0; p < 5; p++) {
      const angle = (p / 5) * Math.PI * 2;
      const petal = new THREE.SphereGeometry(style.canopyRadius * 0.28, 8, 5);
      petal.applyMatrix4(new THREE.Matrix4().makeScale(1.35, 0.18, 0.7));
      petal.rotateZ(angle);
      petal.translate(
        x + Math.cos(angle) * style.canopyRadius * 0.28,
        y + Math.sin(angle) * style.canopyRadius * 0.16,
        Math.sin(angle) * style.canopyRadius * 0.28,
      );
      paintVertexColors(petal, bloom, 0.1, 630 + f * 10 + p);
      parts.push(petal);
    }

    // Orchid's distinctive central lip.
    const flowerLip = new THREE.SphereGeometry(style.canopyRadius * 0.16, 8, 5);
    flowerLip.applyMatrix4(new THREE.Matrix4().makeScale(1.2, 0.25, 0.8));
    flowerLip.translate(x, y - style.canopyRadius * 0.03, style.canopyRadius * 0.32);
    paintVertexColors(flowerLip, lip, 0.08, 700 + f);
    parts.push(flowerLip);
  }

  return merge(parts);
};




// -----------------------------------------------------------------------------
// CREATE PLANT GEOMETRY
// -----------------------------------------------------------------------------

export const createPlantGeometry = (
  type: string,
): THREE.BufferGeometry => {
  const style = plantStyleFromType(type);
  const normalizedType = type.trim().toLowerCase();

  const flowerSpecies =
    style.species === 'flower' ||
    style.species === 'rose' ||
    style.species === 'tulip' ||
    style.species === 'sunflower';

  const noTrunkSpecies =
    normalizedType === 'agave' ||
    normalizedType === 'orchid' ||
    normalizedType === 'tumbleweed' ||
    normalizedType === 'willow' ||
    style.species === 'cactus' ||
    style.species === 'willow' ||
    style.species === 'grass' ||
    style.species === 'fern' ||
    style.species === 'bush' ||
    style.species === 'shrub';

  // Flowers use a green stem.
  // Agave, orchid, tumbleweed, grass, fern, bush and shrub have no trunk.
  // Everything else uses its normal trunk.
  const trunk =
    flowerSpecies && normalizedType !== 'orchid'
      ? flowerStem(style)
      : noTrunkSpecies
        ? null
        : makeTrunk(style);

  let canopy: THREE.BufferGeometry;

  if (normalizedType === 'agave') {
    canopy = createAgave(style);
  } else if (normalizedType === 'tumbleweed') {
    canopy = createTumbleweed(style);
  } else if (normalizedType === 'orchid') {
    canopy = createOrchid(style);
  } else if (normalizedType === 'willow') {
    canopy = createWillow(style);
  } else {
    switch (style.species) {
    case 'oak':
      canopy = createOakCanopy(style);
      break;

    case 'pine':
      canopy = createPineCanopy(style);
      break;

    case 'maple':
      canopy = createMapleCanopy(style);
      break;

    case 'willow':
      canopy = createWillow(style);
      break;

    case 'palm':
      canopy = createPalmCanopy(style);
      break;

    case 'cactus':
      canopy = createCactus(style);
      break;

    case 'succulent':
      canopy = createCactusCanopy(style);
      break;

    // -----------------------------------------------------------------------
    // FLOWERS
    // -----------------------------------------------------------------------
    //
    // IMPORTANT:
    //
    // Do NOT do this anymore:
    //
    //   canopy.rotateX(Math.PI / 2);
    //   canopy.translate(
    //     0,
    //     -style.canopyRadius * 0.05,
    //     style.canopyRadius * 0.42,
    //   );
    //
    // The flower geometry is already Y-up.
    //
    // createFlowerHead(), createTulip(), and createRose() each calculate
    // the stem-top position themselves, so there is nothing else to offset
    // here.
    // -----------------------------------------------------------------------

    case 'rose':
      canopy = createRose(style);
      break;

    case 'tulip':
      canopy = createTulip(style);
      break;

    case 'sunflower':
      canopy = createSunflowerHead(style);
      break;

    case 'flower':
      canopy = createFlowerHead(style);
      break;

    case 'fern':
      canopy = createFern(style);
      break;

    case 'grass':
      canopy = createGrass(style);
      break;

    case 'bush':
    case 'shrub':
      canopy = createBush(style);
      break;

    case 'mushroom':
      canopy = createMushroom(style);
      break;

    default: {
      canopy =
        new THREE.SphereGeometry(
          style.canopyRadius,
          10,
          7,
        );

      canopy.applyMatrix4(
        new THREE.Matrix4().makeScale(
          1.1,
          0.85,
          1,
        ),
      );

      canopy.translate(
        0,
        style.height +
          style.canopyRadius * 0.45,
        0,
      );

      paintVertexColors(
        canopy,
        style.leafColor,
        0.1,
        350,
      );

      break;
    }
  }
  }

  const geometry = merge(
    trunk
      ? [trunk, canopy]
      : [canopy],
  );

  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
};

function RotatingPlantMesh({ geometry }: { geometry: THREE.BufferGeometry }) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.4;
    }
  });

  return (
    <mesh ref={meshRef} geometry={geometry} position={[0, 0, 0]}>
      <meshStandardMaterial vertexColors flatShading side={THREE.DoubleSide} />
    </mesh>
  );
}

function FitPreviewCamera({ geometry }: { geometry: THREE.BufferGeometry }) {
  const camera = useThree((state) => state.camera as THREE.PerspectiveCamera);

  useEffect(() => {
    geometry.computeBoundingSphere();
    let sphere = geometry.boundingSphere;
    if (!sphere || !isFinite(sphere.radius) || sphere.radius <= 0) {
      // Fallback: use bounding box when the sphere is missing or invalid
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (box) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const radius = size.length() * 0.5 || 0.8;
        sphere = new THREE.Sphere(center, radius);
      }
    }
    if (!sphere) return;

    const center = sphere.center.clone();
    const radius = sphere.radius;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = radius / Math.sin(fov / 2) * 1.25;
    const direction = new THREE.Vector3(2.2, 1.5, 2.2).normalize();

    camera.position.copy(direction.multiplyScalar(distance).add(center));
    camera.near = Math.max(0.1, distance * 0.05);
    camera.far = Math.max(100, distance * 10);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }, [camera, geometry]);

  return null;
}

export function PlantPreview({ type }: { type: string }) {
  const previewGeometry = useMemo(() => createPlantGeometry(type), [type]);

  return (
    <Canvas camera={{ position: [2.2, 1.5, 2.2], fov: 35 }} className="h-36 w-full rounded-2xl bg-black/70">
      <FitPreviewCamera geometry={previewGeometry} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[2, 4, 2]} intensity={1.2} />
      <directionalLight position={[-2, -1, -2]} intensity={0.6} />
      <RotatingPlantMesh geometry={previewGeometry} />
    </Canvas>
  );
}

const surfaceNormal = (
  groundAt: (x: number, z: number) => number,
  x: number,
  z: number,
) => {
  const y = groundAt(x, z);
  const dx = groundAt(x + 1, z) - y;
  const dz = groundAt(x, z + 1) - y;
  const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
  const slope = Math.sqrt(dx * dx + dz * dz);
  return { normal, slope };
};

export const createVegetationPatch = (
  groundAt: (x: number, z: number) => number,
  x: number,
  z: number,
  type: string,
): VegetationPatch => {
  const seed = hashString(`${type}:${x.toFixed(2)}:${z.toFixed(2)}`);
  const rand = seededRandom(seed);
  const instances: VegetationInstance[] = [];
  const radius = 20;
  const target = 180;

  for (let i = 0; i < target * 3 && instances.length < target; i++) {
    const angle = rand() * Math.PI * 2;
    const distance = Math.sqrt(rand()) * radius;
    const px = x + Math.cos(angle) * distance;
    const pz = z + Math.sin(angle) * distance;
    const { normal, slope } = surfaceNormal(groundAt, px, pz);
    if (slope > 0.25) continue;

    const height = groundAt(px, pz);
    const uniformScale = 0.62 + rand() * 0.78;

    // Non-uniform scale prevents the forest from looking like copies of one
    // mesh stamped onto the terrain. It is deterministic, so every client
    // still sees the exact same vegetation.
    const scale: [number, number, number] = [
      uniformScale * (0.88 + rand() * 0.24),
      uniformScale * (0.88 + rand() * 0.28),
      uniformScale * (0.88 + rand() * 0.24),
    ];

    const base = vegetationColor(type).clone();
    base.offsetHSL(
      (rand() - 0.5) * 0.08,
      (rand() - 0.5) * 0.14,
      (rand() - 0.5) * 0.16,
    );

    instances.push({
      position: [px, height, pz],
      rotation: rand() * Math.PI * 2,
      scale,
      color: base.toArray() as [number, number, number],
      normal: [normal.x, normal.y, normal.z],
    });
  }

  return {
    id: `${Date.now()}-${type.replace(/\s+/g, '-')}`,
    type,
    instances,
  };
};

const chooseWeightedPlant = (
  plants: { type: string; weight: number }[],
  rand: () => number,
) => {
  const total = plants.reduce((sum, item) => sum + item.weight, 0);
  let threshold = rand() * total;
  for (const item of plants) {
    threshold -= item.weight;
    if (threshold <= 0) return item.type;
  }
  return plants[plants.length - 1].type;
};

export const createVegetationPatches = (
  groundAt: (x: number, z: number) => number,
  x: number,
  z: number,
  selection: string,
): VegetationPatch[] => {
  const biome = biomeMap.get(selection);
  if (!biome) {
    return [createVegetationPatch(groundAt, x, z, selection)];
  }

  const seed = hashString(`${selection}:${x.toFixed(2)}:${z.toFixed(2)}`);
  const rand = seededRandom(seed);
  const instancesByType = new Map<string, VegetationInstance[]>();
  const radius = 20;
  const target = 180;

  for (let i = 0; i < target * 3 && Array.from(instancesByType.values()).reduce((sum, list) => sum + list.length, 0) < target; i++) {
    const angle = rand() * Math.PI * 2;
    const distance = Math.sqrt(rand()) * radius;
    const px = x + Math.cos(angle) * distance;
    const pz = z + Math.sin(angle) * distance;
    const { normal, slope } = surfaceNormal(groundAt, px, pz);
    if (slope > 0.25) continue;

    const height = groundAt(px, pz);
    const uniformScale = 0.62 + rand() * 0.78;
    const scale: [number, number, number] = [
      uniformScale * (0.88 + rand() * 0.24),
      uniformScale * (0.88 + rand() * 0.28),
      uniformScale * (0.88 + rand() * 0.24),
    ];

    const plantType = chooseWeightedPlant(biome.plants, rand);
    const base = vegetationColor(plantType).clone();
    base.offsetHSL((rand() - 0.5) * 0.08, (rand() - 0.5) * 0.14, (rand() - 0.5) * 0.16);

    const list = instancesByType.get(plantType) ?? [];
    list.push({
      position: [px, height, pz],
      rotation: rand() * Math.PI * 2,
      scale,
      color: base.toArray() as [number, number, number],
      normal: [normal.x, normal.y, normal.z],
    });
    instancesByType.set(plantType, list);
  }

  return Array.from(instancesByType.entries()).map(([type, instances], index) => ({
    id: `${Date.now()}-${selection}-${type.replace(/\s+/g, '-')}-${index}`,
    type,
    instances,
  }));
};


function PlantInstances({
  geometry,
  instances,
}: {
  geometry: THREE.BufferGeometry;
  instances: VegetationInstance[];
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!meshRef.current) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    instances.forEach((instance, index) => {
      dummy.position.set(...instance.position);

      // Align the plant's local Y axis with the sampled terrain normal while
      // preserving a deterministic heading around that axis.
      const normal = new THREE.Vector3(...instance.normal).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      dummy.quaternion.setFromUnitVectors(up, normal);
      dummy.rotateY(instance.rotation);

      dummy.scale.set(...instance.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });

    mesh.count = instances.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [instances, dummy, geometry]);

  return (
    <instancedMesh ref={meshRef} args={[geometry, undefined, instances.length]} castShadow receiveShadow>
      <meshStandardMaterial
        vertexColors
        roughness={0.86}
        metalness={0}
        flatShading={false}
      />
    </instancedMesh>
  );
}

export function VegetationLayer({ patches }: { patches: VegetationPatch[] }) {
  const plantsByType = useMemo(() => {
    const groups = new Map<string, VegetationInstance[]>();
    for (const patch of patches) {
      const list = groups.get(patch.type) ?? [];
      list.push(...patch.instances);
      groups.set(patch.type, list);
    }
    return groups;
  }, [patches]);

  const plantGeometries = useMemo(() => {
    const map = new Map<string, THREE.BufferGeometry>();
    for (const type of plantsByType.keys()) {
      map.set(type, createPlantGeometry(type));
    }
    return map;
  }, [plantsByType]);

  if (!patches.length) return null;

  return (
    <>
      {Array.from(plantsByType.entries()).map(([type, instances]) => (
        <PlantInstances
          key={type}
          geometry={plantGeometries.get(type)!}
          instances={instances}
        />
      ))}
    </>
  );
}

export function VegetationPanel({
  onPlant,
  onCancel,
}: {
  onPlant: (type: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState('');
  const [biome, setBiome] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [hoveredPlant, setHoveredPlant] = useState(VEGETATION_LIBRARY[0]?.type ?? 'oak');

  const selectedPlant = useMemo(
    () =>
      VEGETATION_LIBRARY.find(
        (item) =>
          item.type.toLowerCase() === type.trim().toLowerCase() ||
          item.name.toLowerCase() === type.trim().toLowerCase(),
      ),
    [type],
  );

  const selectedBiome = useMemo(
    () => biomeMap.get(biome),
    [biome],
  );

  const submit = useCallback(() => {
    if (selectedBiome) {
      onPlant(selectedBiome.type);
      return;
    }
    if (!selectedPlant) return;
    onPlant(selectedPlant.type);
  }, [onPlant, selectedBiome, selectedPlant]);

  const chooseItem = useCallback(
    (selected: string) => {
      if (biomeMap.has(selected)) {
        setBiome(selected);
        setType('');
        onPlant(selected);
        return;
      }
      setBiome('');
      setType(selected);
      onPlant(selected);
    },
    [onPlant],
  );

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-xl border border-white/10 bg-neutral-900 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Plant vegetation here</h2>
            <p className="mt-1 text-sm text-white/60">
              Type a vegetation type like “cherry blossom” or “dead forest”. Hundreds of plants will appear on the terrain surface.
            </p>
          </div>
          <button
            onClick={() => setShowLibrary((prev) => !prev)}
            className="rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10"
          >
            {showLibrary ? 'Back to text' : 'Browse plants'}
          </button>
        </div>

        {showLibrary ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="max-h-[calc(100vh-260px)] overflow-auto space-y-3">
              {VEGETATION_LIBRARY.map((item) => (
                <button
                  key={item.type}
                  onClick={() => chooseItem(item.type)}
                  onMouseEnter={() => setHoveredPlant(item.type)}
                  className="group w-full overflow-hidden rounded-3xl border border-white/10 bg-black/40 px-4 py-5 text-left transition hover:border-emerald-400/70 hover:bg-white/5"
                >
                  <p className="text-lg font-semibold text-white">{item.name}</p>
                </button>
              ))}
            </div>
            <div className="sticky top-6 rounded-3xl border border-white/10 bg-black/40 p-4">
              <p className="text-xs uppercase tracking-[0.24em] text-white/50">Plant preview</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {(VEGETATION_LIBRARY.find((item) => item.type === hoveredPlant) ?? VEGETATION_LIBRARY[0])?.name}
              </p>
              <div className="mt-4 rounded-3xl border border-white/10 bg-black/80 p-3">
                <PlantPreview type={hoveredPlant} />
              </div>
              <p className="mt-4 text-sm text-white/60">
                Hover over a plant to preview it, then click the card to select it.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <select
                  value={biome}
                  onChange={(e) => {
                    setBiome(e.target.value);
                    if (e.target.value) {
                      setType('');
                    }
                  }}
                  className="w-full rounded-lg border border-white/15 bg-neutral-800 px-4 py-3 text-white outline-none focus:border-emerald-400"
                >
                  <option value="">Select a biome</option>
                  {BIOMES.map((item) => (
                    <option key={item.type} value={item.type}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => setBiome('')}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-sm text-white hover:bg-white/10"
              >
                Clear biome
              </button>
            </div>
            {!selectedBiome && (
              <input
                value={type}
                onChange={(e) => setType(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Pick a plant from the list"
                className="mt-4 w-full rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-white outline-none placeholder:text-white/40 focus:border-emerald-400"
                autoFocus
              />
            )}

            {selectedBiome ? (
              <div className="mt-4 rounded-3xl border border-white/10 bg-black/40 p-4">
                <p className="text-sm text-white/70">{selectedBiome.name} biome</p>
                <div className="mt-3 space-y-2 text-sm text-white/60">
                  <p>Plant composition:</p>
                  {selectedBiome.plants.map((entry, i) => (
                    <p key={`${entry.type}-${i}`}>
                      {entry.type.charAt(0).toUpperCase() + entry.type.slice(1)} — {entry.weight}%
                    </p>
                  ))}
                </div>
              </div>
            ) : selectedPlant ? (
              <div className="mt-4 rounded-3xl border border-white/10 bg-black/40 p-4">
                <p className="text-sm text-white/70">Preview of “{selectedPlant.name}”</p>
                <div className="mt-3 rounded-2xl border border-white/10 bg-black/80 p-2">
                  <PlantPreview type={selectedPlant.type} />
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-3xl border border-white/10 bg-black/40 p-4">
                <p className="text-sm text-white/50">No preview available for this name</p>
              </div>
            )}
            {selectedPlant ? null : type.trim() ? (
              <div className="mt-4 rounded-3xl border border-red-500/30 bg-black/40 p-4 text-red-200">
                <p className="text-sm">Please choose a plant from the provided list.</p>
              </div>
            ) : null}
          </>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-emerald-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!selectedPlant && !selectedBiome}
          >
            Plant
          </button>
        </div>
      </div>
    </div>
  );
}
