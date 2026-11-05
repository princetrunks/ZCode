// Sando (ShrineTech): the three.js 3D model viewer (SANDO-VIEWER3D.md; ported from the Planner's lib/model3dViewer.js).
// Reached ONLY through a dynamic import() (components/ai-elements/model3d-view.tsx), so three.js and its loaders are their own
// chunk and nobody who never opens a model downloads them. Everything is bundled: no CDN, no decoder downloads (Draco / KTX2 /
// meshopt GLBs are refused with a message), no network at all. The caller hands in the file's bytes, and a .gltf's sibling
// files come through `readSibling` (the same IFileService path); any other URL inside a model resolves to nothing.
//
// Renders on demand (OrbitControls 'change', resize), never in a loop, so an idle viewer costs nothing.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { gltfExternalUris, model3dFormatInfo, type Model3dFormat } from "./model3dSpec.js";

export type Model3dBackground = "dark" | "light";
export interface Model3dInfo {
  sizeMm: { x: number; y: number; z: number };
  triangles: number;
}
export interface Model3dViewerHandle {
  reset(): void;
  resize(): void;
  setWireframe(on: boolean): void;
  setBackground(bg: Model3dBackground): void;
  dispose(): void;
}
export interface Model3dViewerOptions {
  format: Model3dFormat;
  data: ArrayBuffer;
  /** A .gltf's relative resource (as written in the file) → its bytes, or null when refused / missing. */
  readSibling?: (ref: string) => Promise<ArrayBuffer | null>;
  background?: Model3dBackground;
  onInfo?: (info: Model3dInfo) => void;
  onError?: (message: string) => void;
}

const BACKGROUNDS: Record<Model3dBackground, number> = { dark: 0x1b1d24, light: 0xeceef3 };
const GRID: Record<Model3dBackground, [number, number]> = {
  dark: [0x5b6078, 0x353849],
  light: [0x9aa0b4, 0xcfd3de],
};
const BASE_COLOR = 0x9aa5ce;
const REL = "sando-rel:/";
const REFUSED = "data:,refused";

const standardMaterial = () =>
  new THREE.MeshStandardMaterial({
    color: BASE_COLOR,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

/** Only the model's own bytes, data:/blob: URIs and the pre-read siblings ever load; everything else maps to nothing. */
function lockedManager(siblings: Map<string, string>): THREE.LoadingManager {
  const m = new THREE.LoadingManager();
  m.setURLModifier((u) => {
    if (/^(?:data|blob):/i.test(u)) return u;
    if (u.startsWith(REL)) return siblings.get(u.slice(REL.length)) ?? REFUSED;
    return REFUSED;
  });
  return m;
}

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const materialsOf = (o: THREE.Mesh): THREE.Material[] =>
  (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean);

async function loadObject(opts: Model3dViewerOptions, blobUrls: string[]): Promise<THREE.Object3D> {
  const info = model3dFormatInfo(opts.format);
  const buf = opts.data;
  if (info.loader === "stl") {
    const geom = new STLLoader().parse(buf);
    if (!geom.attributes["normal"]) geom.computeVertexNormals();
    const hasColors = (geom as THREE.BufferGeometry & { hasColors?: boolean }).hasColors;
    const mat = hasColors
      ? new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.6,
          side: THREE.DoubleSide,
        })
      : standardMaterial();
    return new THREE.Mesh(geom, mat);
  }
  if (info.loader === "3mf") {
    const group = new ThreeMFLoader(lockedManager(new Map())).parse(buf);
    group.traverse((o) => {
      if (!isMesh(o)) return;
      if (!o.geometry.attributes["normal"]) o.geometry.computeVertexNormals();
      // 3MF without colour groups comes back plain white; give it the viewer's base colour instead.
      for (const mat of materialsOf(o)) {
        const c = (mat as THREE.MeshStandardMaterial).color;
        if (c && c.getHex() === 0xffffff && !o.geometry.attributes["color"]) c.setHex(BASE_COLOR);
      }
    });
    return group;
  }
  if (info.loader === "obj") {
    const group = new OBJLoader().parse(new TextDecoder().decode(buf));
    group.traverse((o) => {
      if (!isMesh(o)) return;
      if (!o.geometry.attributes["normal"]) o.geometry.computeVertexNormals();
      o.material = standardMaterial();
    });
    return group;
  }
  // glTF / GLB. A .gltf (JSON) names its .bin and textures by relative URI: read them first through readSibling and hand
  // the loader blob: URLs, so the loader itself never touches the network.
  const siblings = new Map<string, string>();
  if (opts.format === "gltf") {
    let json: unknown = null;
    try {
      json = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      throw new Error("the .gltf is not valid JSON");
    }
    const bufferUris = new Set(
      gltfExternalUris({ buffers: (json as { buffers?: unknown[] } | null)?.buffers ?? [] }),
    );
    for (const uri of gltfExternalUris(json)) {
      const bytes = opts.readSibling ? await opts.readSibling(uri).catch(() => null) : null;
      if (!bytes) {
        // A missing texture still shows the shape; a missing buffer means there is no geometry to show.
        if (bufferUris.has(uri))
          throw new Error(
            `it needs "${uri.slice(0, 80)}", which is missing or outside the model's folder`,
          );
        continue;
      }
      const url = URL.createObjectURL(new Blob([bytes]));
      blobUrls.push(url);
      siblings.set(uri, url);
    }
  }
  const loader = new GLTFLoader(lockedManager(siblings));
  const gltf = await loader.parseAsync(buf, REL);
  const root = gltf.scene ?? gltf.scenes?.[0];
  if (!root) throw new Error("the file has no scene");
  return root;
}

function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (!isMesh(o) || !o.geometry) return;
    const g = o.geometry;
    n += g.index ? g.index.count / 3 : (g.attributes["position"]?.count ?? 0) / 3;
  });
  return Math.round(n);
}

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message || err || "could not load");
  if (/DRACO|draco|meshopt|KTX2|basisu/i.test(msg))
    return "compressed glTF (Draco / meshopt / KTX2) is not supported here";
  return msg.slice(0, 160);
}

export function mountModel3dViewer(
  host: HTMLElement,
  opts: Model3dViewerOptions,
): Model3dViewerHandle {
  const info = model3dFormatInfo(opts.format);
  let bg: Model3dBackground = opts.background ?? "dark";
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "sando-m3d__canvas";
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUNDS[bg]);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 1.6, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(-1.2, 0.4, -1);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e7);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;

  let disposed = false;
  let object: THREE.Object3D | null = null;
  let grid: THREE.GridHelper | null = null;
  let gridSpec: { size: number; cells: number; pos: THREE.Vector3 } | null = null;
  let fit: { center: THREE.Vector3; radius: number } | null = null;
  const blobUrls: string[] = [];

  const render = () => {
    if (!disposed) renderer.render(scene, camera);
  };
  controls.addEventListener("change", render);

  const resize = () => {
    if (disposed) return;
    const w = host.clientWidth || 320;
    const h = host.clientHeight || 240;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(host);

  const placeGrid = () => {
    if (!gridSpec) return;
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    const [major, minor] = GRID[bg];
    grid = new THREE.GridHelper(gridSpec.size, gridSpec.cells, major, minor);
    grid.position.copy(gridSpec.pos);
    scene.add(grid);
  };

  const reset = () => {
    if (!fit) return;
    const { center, radius } = fit;
    // Fit the bounding sphere in the narrower of the two fields of view (a tall, narrow side pane would crop it otherwise).
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
    camera.near = Math.max(radius / 1000, 1e-4);
    camera.far = dist * 20 + radius * 10;
    camera.position
      .copy(center)
      .add(new THREE.Vector3(0.9, 0.65, 1).normalize().multiplyScalar(dist));
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    render();
  };

  loadObject(opts, blobUrls)
    .then((obj) => {
      if (disposed) return;
      object = obj;
      // Everything in millimetres, Y up: print formats are Z-up mm, glTF is Y-up metres.
      const holder = new THREE.Group();
      holder.add(obj);
      if (info.zUp) obj.rotation.x = -Math.PI / 2;
      holder.scale.setScalar(info.mmPerUnit);
      scene.add(holder);
      holder.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      if (box.isEmpty()) throw new Error("the file has no geometry");
      const size = box.getSize(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      fit = { center: sphere.center, radius: Math.max(sphere.radius, 1e-3) };
      // A floor grid at the model's base, in 10 mm cells (100 mm for big models).
      const span = Math.max(size.x, size.z) * 1.6;
      const cell = span > 600 ? 100 : 10;
      const cells = Math.max(2, Math.min(200, Math.ceil(span / cell)));
      gridSpec = {
        size: cells * cell,
        cells,
        pos: new THREE.Vector3(sphere.center.x, box.min.y, sphere.center.z),
      };
      placeGrid();
      // Readout: width (x) × depth (z) × height (y) in mm.
      opts.onInfo?.({
        sizeMm: { x: size.x, y: size.z, z: size.y },
        triangles: countTriangles(obj),
      });
      reset();
    })
    .catch((err) => {
      if (!disposed) opts.onError?.(friendlyError(err));
    });

  resize();

  return {
    reset,
    resize,
    setWireframe(on) {
      object?.traverse((o) => {
        if (!isMesh(o)) return;
        for (const m of materialsOf(o)) (m as THREE.MeshStandardMaterial).wireframe = on;
      });
      render();
    },
    setBackground(next) {
      bg = next;
      scene.background = new THREE.Color(BACKGROUNDS[bg]);
      placeGrid();
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ro?.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        if (!m.material) return;
        for (const mat of materialsOf(m)) {
          for (const v of Object.values(mat))
            if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
          mat.dispose();
        }
      });
      for (const u of blobUrls) URL.revokeObjectURL(u);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
