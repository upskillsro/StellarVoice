import React, { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface DotSphereProps {
  analyserNode: AnalyserNode | null;
}

export function DotSphere({ analyserNode }: DotSphereProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  // Keep dataArray synced with analyserNode
  useEffect(() => {
    if (analyserNode) {
      dataArrayRef.current = new Uint8Array(analyserNode.frequencyBinCount);
    } else {
      dataArrayRef.current = null;
    }
  }, [analyserNode]);

  const { positions, originalPositions } = useMemo(() => {
    const geometry = new THREE.IcosahedronGeometry(0.98, 16);
    const posAttribute = geometry.getAttribute('position');
    const count = posAttribute.count;
    const positions = new Float32Array(count * 3);
    const originalPositions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = posAttribute.getX(i);
      positions[i * 3 + 1] = posAttribute.getY(i);
      positions[i * 3 + 2] = posAttribute.getZ(i);
      originalPositions[i * 3]     = posAttribute.getX(i);
      originalPositions[i * 3 + 1] = posAttribute.getY(i);
      originalPositions[i * 3 + 2] = posAttribute.getZ(i);
    }
    return { positions, originalPositions };
  }, []);

  useFrame((state) => {
    if (!pointsRef.current) return;

    let volume = 0;
    if (analyserNode && dataArrayRef.current) {
      analyserNode.getByteFrequencyData(dataArrayRef.current);
      let sum = 0;
      const bins = Math.min(50, dataArrayRef.current.length);
      for (let i = 0; i < bins; i++) sum += dataArrayRef.current[i];
      volume = sum / bins / 255.0;
    }

    const ud = pointsRef.current.userData;
    if (ud.smoothVolume === undefined) ud.smoothVolume = 0;
    ud.smoothVolume += (volume - ud.smoothVolume) * 0.1;
    const v = ud.smoothVolume;

    pointsRef.current.rotation.y += 0.001;
    pointsRef.current.rotation.x += 0.0005;

    const time = state.clock.getElapsedTime();
    const posAttr = pointsRef.current.geometry.getAttribute('position');
    const _v3 = new THREE.Vector3();

    for (let i = 0; i < posAttr.count; i++) {
      const ox = originalPositions[i * 3];
      const oy = originalPositions[i * 3 + 1];
      const oz = originalPositions[i * 3 + 2];
      _v3.set(ox, oy, oz);
      const dist = _v3.length();
      const dir = _v3.clone().normalize();
      const noise = Math.sin(ox * 2 + time) * Math.cos(oy * 2 + time * 0.8) * Math.sin(oz * 2 + time * 0.9);
      const displacement = v * 0.4 * (1 + noise) + v * 0.1;
      const target = dir.multiplyScalar(dist + displacement);
      posAttr.setXYZ(i, target.x, target.y, target.z);
    }

    posAttr.needsUpdate = true;
    const s = 1 + v * 0.05;
    pointsRef.current.scale.set(s, s, s);
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.03}
        color="#a78bfa"
        transparent
        opacity={0.8}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}
