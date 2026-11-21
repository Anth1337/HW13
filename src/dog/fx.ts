import * as THREE from "three";

/*
 * Little flat-colour hearts that float up from where the dog is petted.
 * Everything (geometry, a material per pooled heart) is created once; burst() only reuses
 * pooled meshes, so petting never allocates GPU resources.
 */

const POOL_SIZE = 24;
const HEART_SIZE = 0.06; // m, overall width
const LIFE = 1.5; // s
const RISE = 0.25; // m
const COLORS = [0xe8384f, 0xff6f91, 0xff8fab, 0xd62246];

function heartGeometry(): THREE.BufferGeometry {
  // Classic parametric heart (point at the bottom), ~34 units wide before scaling.
  const pts: THREE.Vector2[] = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push(new THREE.Vector2(x, y));
  }
  const shape = new THREE.Shape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 6,
    bevelEnabled: true,
    bevelThickness: 1.5,
    bevelSize: 1.5,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.center();
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const s = HEART_SIZE / (box.max.x - box.min.x);
  geo.scale(s, s, s);
  geo.computeVertexNormals();
  return geo;
}

interface Heart {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  active: boolean;
  age: number;
  life: number;
  start: THREE.Vector3;
  driftX: number;
  driftZ: number;
  phase: number;
  spin: number;
  scale: number;
}

export function createPetFx(scene: THREE.Scene): {
  burst(worldPoint: THREE.Vector3, zone: "head" | "body"): void;
  update(dt: number): void;
  dispose(): void;
} {
  const group = new THREE.Group();
  group.name = "petFx";
  scene.add(group);

  const geo = heartGeometry();
  const hearts: Heart[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: COLORS[i % COLORS.length],
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 10;
    group.add(mesh);
    hearts.push({
      mesh, mat, active: false, age: 0, life: LIFE, start: new THREE.Vector3(),
      driftX: 0, driftZ: 0, phase: 0, spin: 0, scale: 1,
    });
  }

  function take(): Heart {
    let oldest = hearts[0];
    for (const h of hearts) {
      if (!h.active) return h;
      if (h.age / h.life > oldest.age / oldest.life) oldest = h;
    }
    return oldest; // pool exhausted: recycle the most faded heart
  }

  function place(h: Heart): void {
    const u = Math.min(h.age / h.life, 1);
    const rise = RISE * (1 - (1 - u) * (1 - u)); // ease-out
    const wob = Math.sin(h.phase + h.age * 7) * 0.012 * (1 - u * 0.5);
    h.mesh.position.set(
      h.start.x + h.driftX * u + wob,
      h.start.y + rise,
      h.start.z + h.driftZ * u,
    );
    // Pop in over the first 0.15 s, shrink a little at the end.
    const pop = Math.min(h.age / 0.15, 1);
    const popEase = 1 + 0.25 * Math.sin(pop * Math.PI); // small overshoot
    h.mesh.scale.setScalar(h.scale * pop * popEase * (1 - 0.3 * u));
    h.mesh.rotation.set(0, h.phase + h.age * h.spin, Math.sin(h.phase + h.age * 5) * 0.25);
    h.mat.opacity = u < 0.6 ? 1 : Math.max(0, 1 - (u - 0.6) / 0.4);
  }

  return {
    burst(worldPoint: THREE.Vector3, zone: "head" | "body"): void {
      const n = 3 + Math.floor(Math.random() * 3); // 3–5
      const spread = zone === "head" ? 0.05 : 0.08;
      for (let i = 0; i < n; i++) {
        const h = take();
        h.active = true;
        h.age = -i * 0.08; // stagger
        h.life = LIFE * (0.85 + Math.random() * 0.3);
        h.start.set(
          worldPoint.x + (Math.random() - 0.5) * 2 * spread,
          worldPoint.y + 0.03 + Math.random() * 0.03,
          worldPoint.z + (Math.random() - 0.5) * 2 * spread,
        );
        h.driftX = (Math.random() - 0.5) * 0.08;
        h.driftZ = (Math.random() - 0.5) * 0.08;
        h.phase = Math.random() * Math.PI * 2;
        h.spin = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 1.5);
        h.scale = 0.75 + Math.random() * 0.5;
        h.mesh.visible = false;
        h.mat.opacity = 0;
      }
    },

    update(dt: number): void {
      const d = Math.min(Math.max(dt, 0), 0.1);
      for (const h of hearts) {
        if (!h.active) continue;
        h.age += d;
        if (h.age < 0) continue; // staggered start
        if (h.age >= h.life) {
          h.active = false;
          h.mesh.visible = false;
          continue;
        }
        h.mesh.visible = true;
        place(h);
      }
    },

    dispose(): void {
      scene.remove(group);
      geo.dispose();
      for (const h of hearts) h.mat.dispose();
      hearts.length = 0;
    },
  };
}
