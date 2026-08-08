// TEMPORARY visual harness — delete after review.
'use client';
import { Canvas } from '@react-three/fiber';
import { Weather } from '../world/weather';
import type { Contribution, WeatherPayload } from '../world/contract';
import { useThree, useFrame } from '@react-three/fiber';

function Probe() {
  const { scene, camera } = useThree();
  useFrame(() => {
    const out: any[] = [];
    scene.traverse((o: any) => {
      out.push({
        type: o.type, visible: o.visible,
        pos: o.position.toArray().map((n: number) => +n.toFixed(1)),
        scale: +o.scale.x.toFixed(1),
        count: o.count ?? null,
        opacity: o.material && !Array.isArray(o.material) ? +(o.material.opacity ?? 1).toFixed(2) : null,
      });
    });
    (window as any).__probe = { cam: camera.position.toArray().map((n: number) => +n.toFixed(1)), objs: out };
  });
  return null;
}

export default function Rig() {
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const c = q?.get('c') ?? 'clear';
  const t = Number(q?.get('t') ?? '0.35');
  const y = Number(q?.get('y') ?? '3');
  const zones: Contribution<WeatherPayload>[] = c === 'clear' ? [] : [{
    id: c, kind: 'weather', x: 0, z: 0, rotation: 0, author: 'rig', created_at: '',
    payload: { condition: c, intensity: 1, radius: 900 },
  }];
  return (
    <div className="h-screen w-screen bg-black">
      <Canvas shadows camera={{ position: [0, y, 14], fov: 72, near: 0.5, far: 3000 }} onCreated={({camera})=>{const p=Number(q?.get('p')??'0'); camera.rotation.order='YXZ'; const yaw=Number(q?.get('yaw')??'0'); camera.rotation.y = yaw*Math.PI/180; camera.rotation.x = p*Math.PI/180;}}>
        <Weather zones={zones} timeOverride={t} />
        <Probe />
        <mesh rotation={[-Math.PI/2,0,0]} position={[0,-1,0]} receiveShadow>
          <planeGeometry args={[1200,1200]} />
          <meshStandardMaterial color="#5f6a4d" roughness={0.97} />
        </mesh>
        <mesh position={[6,3,-26]} castShadow>
          <boxGeometry args={[8,9,8]} />
          <meshStandardMaterial color="#7d8a99" />
        </mesh>
        <mesh position={[-14,1,-18]} castShadow>
          <boxGeometry args={[6,5,6]} />
          <meshStandardMaterial color="#6b7a6a" />
        </mesh>
      </Canvas>
    </div>
  );
}
