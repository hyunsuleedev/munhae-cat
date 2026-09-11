import * as THREE from 'three';
import { createCalligraphy, WRITING_START, WRITING_END } from './calligraphy';

const W = 2.08;
const H = 2.86;
const FONT = '"AppleMyungjo", "Apple Myungjo", "Songti SC", "Noto Serif CJK KR", serif';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => { const t = clamp(n); return t * t * t * (t * (t * 6 - 15) + 10); };

function random(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function paper(ctx: CanvasRenderingContext2D, w: number, h: number, cover = false) {
  const rand = random(71);
  ctx.fillStyle = cover ? '#31483f' : '#e7ddbd'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 19000; i++) {
    const x = rand() * w, y = rand() * h;
    ctx.strokeStyle = cover ? `rgba(220,213,176,${rand() * .09})` : `rgba(119,96,48,${rand() * .07})`;
    ctx.lineWidth = .4 + rand() * .7;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (cover ? 0 : rand() * 5), y + rand() * 7); ctx.stroke();
  }
  if (cover) {
    ctx.strokeStyle = '#1b302a26';
    for (let i = 0; i < w; i += 3) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke(); }
  } else {
    const shade = ctx.createLinearGradient(0, 0, w, 0);
    shade.addColorStop(0, '#897a4b30'); shade.addColorStop(.065, '#897a4b00');
    shade.addColorStop(.86, '#fff8df00'); shade.addColorStop(1, '#ac945316');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, w, h);
  }
}

function border(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.strokeStyle = '#69694977'; ctx.lineWidth = 1.4;
  ctx.strokeRect(83, 82, w - 143, h - 165);
  ctx.strokeRect(90, 89, w - 157, h - 179);
}

function manuscript(ctx: CanvasRenderingContext2D, w: number, h: number) {
  paper(ctx, w, h); border(ctx, w, h);
  // Decorative, original copy for this study, not a facsimile of a source edition.
  const columns = ['讀古人之書', '明古人之意', '一字有其源', '一句有其理', '觀文而知義', '循義而通心', '以今日之言', '續千載之思'];
  ctx.font = `27px ${FONT}`; ctx.textAlign = 'center';
  columns.forEach((column, i) => {
    const x = w - 111 - i * 74;
    ctx.strokeStyle = '#65664324'; ctx.beginPath(); ctx.moveTo(x - 38, 90); ctx.lineTo(x - 38, h - 91); ctx.stroke();
    [...column].forEach((char, j) => {
      ctx.fillStyle = `rgba(50,57,43,${.67 + Math.sin(i * 3 + j) * .12})`;
      ctx.fillText(char, x, 160 + j * 51);
    });
  });
  ctx.font = `16px ${FONT}`; ctx.fillStyle = '#6a7059'; ctx.fillText('文 解 · 序', w / 2, h - 44);
}

const vertexDeclarations = `
uniform float uTurn;
uniform float uBase;
uniform float uFlex;
vec3 turnPage(vec3 p) {
  float s = p.x / ${W.toFixed(2)};
  float bend = sin(uTurn) * uFlex;
  float a = uTurn + bend * s;
  return vec3(p.x * cos(a), uBase + p.x * sin(a), p.z + sin(s * 3.14159) * bend * .045 * cos(p.z * 1.5));
}
`;

export type BookScene = {
  render: (seconds: number, pointerX?: number, pointerY?: number, detail?: number) => void;
  dispose: () => void;
};

export async function createBookScene(host: HTMLElement): Promise<BookScene> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(31, 1, .1, 60);
  camera.position.set(4.1, 7.2, 9.4); camera.lookAt(0, .2, 0);
  const book = new THREE.Group(); book.position.y = .55; scene.add(book);
  scene.add(new THREE.HemisphereLight('#fff7e3', '#b3ad91', 1.8));
  const light = new THREE.DirectionalLight('#fff1d5', 2.5);
  light.position.set(-3, 8, 4); light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024); light.shadow.camera.left = -5; light.shadow.camera.right = 5;
  light.shadow.camera.top = 5; light.shadow.camera.bottom = -5;
  light.shadow.normalBias = .018; light.shadow.bias = -.0003; light.shadow.radius = 4;
  scene.add(light);
  const fill = new THREE.DirectionalLight('#e9f0df', .65); fill.position.set(4, 3, -4); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.ShadowMaterial({ color: '#605d42', opacity: .13 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.56; floor.receiveShadow = true; scene.add(floor);

  // A broad contact shadow keeps the floating book grounded without a heavy postprocessing pass.
  const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
  const sc = shadowCanvas.getContext('2d')!; const gradient = sc.createRadialGradient(64, 64, 2, 64, 64, 63);
  gradient.addColorStop(0, '#514c2d24'); gradient.addColorStop(.5, '#514c2d15'); gradient.addColorStop(1, '#514c2d00');
  sc.fillStyle = gradient; sc.fillRect(0, 0, 128, 128);
  const softShadowTexture = new THREE.CanvasTexture(shadowCanvas);
  const softShadow = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 4.7), new THREE.MeshBasicMaterial({ map: softShadowTexture, transparent: true, depthWrite: false }));
  softShadow.rotation.x = -Math.PI / 2; softShadow.position.y = -.55; scene.add(softShadow);

  const plainTexture = canvasTexture(paper);
  const manuscriptTexture = canvasTexture(manuscript);
  const coverTexture = canvasTexture((ctx, w, h) => {
    paper(ctx, w, h, true);
    ctx.strokeStyle = '#a8a17445'; ctx.lineWidth = 2; ctx.strokeRect(23, 23, w - 46, h - 46);
    ctx.fillStyle = '#e0d2ad'; ctx.fillRect(w - 195, 89, 122, 367);
    ctx.strokeStyle = '#695b34'; ctx.lineWidth = 2; ctx.strokeRect(w - 185, 100, 102, 345);
    ctx.font = `64px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = '#2e3a30';
    ctx.fillText('文', w - 134, 199); ctx.fillText('解', w - 134, 287);
    ctx.font = `19px ${FONT}`; ctx.fillText('序', w - 134, 390);
  });
  const endpaperTexture = canvasTexture((ctx, w, h) => {
    paper(ctx, w, h); border(ctx, w, h);
    ctx.font = `27px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = '#535b44';
    [...'讀古人之書'].forEach((char, i) => ctx.fillText(char, w * .58, 267 + i * 60));
    [...'明古人之意'].forEach((char, i) => ctx.fillText(char, w * .41, 306 + i * 60));
  });
  const inkTexture = canvasTexture((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = `18px ${FONT}`; ctx.fillStyle = '#697256'; ctx.textAlign = 'center';
    ctx.fillText('讀 文 · 解 意', w * .52, 936);
    ctx.strokeStyle = '#a9462e'; ctx.lineWidth = 2; ctx.strokeRect(622, 818, 39, 48);
    ctx.fillStyle = '#a9462e'; ctx.font = `16px ${FONT}`; ctx.fillText('文', 642, 837); ctx.fillText('解', 642, 857);
  });
  const calligraphy = createCalligraphy();
  const inkMask = new THREE.CanvasTexture(calligraphy.canvas);
  inkMask.colorSpace = THREE.NoColorSpace;
  inkMask.generateMipmaps = false;
  inkMask.minFilter = THREE.LinearFilter;
  const textures = [plainTexture, manuscriptTexture, coverTexture, endpaperTexture, inkTexture, softShadowTexture, inkMask];
  let disposed = false;

  const coverMaterial = new THREE.MeshStandardMaterial({ map: coverTexture, roughness: .92, metalness: 0 });
  const clothMaterial = new THREE.MeshStandardMaterial({ color: '#344b3e', roughness: 1 });
  const paperMaterial = new THREE.MeshStandardMaterial({ map: plainTexture, roughness: 1, side: THREE.DoubleSide });
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(W + .10, .065, H + .12), clothMaterial);
  bottom.position.set(W / 2, -.025, 0); bottom.castShadow = true; bottom.receiveShadow = true; book.add(bottom);

  // Thin individual sheets expose real page edges when the camera moves.
  const pageLayers = new THREE.Group(); book.add(pageLayers);
  const edgeMaterials = ['#d8cca9', '#e9debd', '#c8bd9c'].map(color => new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  for (let i = 0; i < 23; i++) {
    const layer = new THREE.Mesh(new THREE.BoxGeometry(W - .025 + Math.sin(i * 4) * .012, .009, H - .018 + Math.cos(i * 2) * .01), edgeMaterials[i % 3]);
    layer.position.set(W / 2, .014 + i * .010, 0); layer.castShadow = true; layer.receiveShadow = true; pageLayers.add(layer);
  }
  const turns: { mesh: THREE.Mesh; uniforms: { uTurn: { value: number }; uBase: { value: number }; uFlex: { value: number } }; start: number; duration: number; end: number }[] = [];
  const depthMaterials: THREE.Material[] = [];
  function leaf(map: THREE.Texture, base: number, start: number, duration: number, flex = .36, end = Math.PI * .972) {
    const geometry = new THREE.PlaneGeometry(W, H, 48, 8);
    geometry.translate(W / 2, 0, 0); geometry.rotateX(-Math.PI / 2);
    const uniforms = { uTurn: { value: 0 }, uBase: { value: base }, uFlex: { value: flex } };
    const material = new THREE.MeshStandardMaterial({ map, roughness: .96, side: THREE.DoubleSide });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = vertexDeclarations + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = turnPage(position);');
      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
        float bend = sin(uTurn) * uFlex;
        float a = uTurn + bend * position.x / ${W.toFixed(2)};
        float slope = bend * position.x / ${W.toFixed(2)};
        vec3 objectNormal = normalize(vec3(-sin(a) - slope * cos(a), cos(a) - slope * sin(a), 0.0));
      `);
      if (map !== plainTexture) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
          vec2 pageUv = vec2(gl_FrontFacing ? vMapUv.x : 1.0 - vMapUv.x, vMapUv.y);
          diffuseColor *= texture2D(map, pageUv);
        `);
      }
    };
    material.customProgramCacheKey = () => 'munhae-turn-page-v1';
    const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    depth.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = vertexDeclarations + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = turnPage(position);');
    };
    mesh.customDepthMaterial = depth; depthMaterials.push(depth);
    book.add(mesh); turns.push({ mesh, uniforms, start, duration, end });
    return mesh;
  }
  // The cover has a real hinge and thickness; its paper lining faces up after opening.
  const coverHinge = new THREE.Group(); coverHinge.position.y = .309; book.add(coverHinge);
  const cover = new THREE.Mesh(new THREE.BoxGeometry(W + .07, .042, H + .09), [clothMaterial, clothMaterial, coverMaterial, paperMaterial, clothMaterial, clothMaterial]);
  cover.position.x = W / 2; cover.castShadow = true; cover.receiveShadow = true; coverHinge.add(cover);
  const lining = new THREE.Mesh(new THREE.PlaneGeometry(W - .03, H - .03), new THREE.MeshStandardMaterial({ map: endpaperTexture, roughness: 1 }));
  lining.rotation.x = Math.PI / 2; lining.position.set(W / 2, -.023, 0); coverHinge.add(lining);

  leaf(manuscriptTexture, .276, .82, 1.34, .42, Math.PI * .953);
  leaf(manuscriptTexture, .266, 1.09, 1.43, .34, Math.PI * .943);
  leaf(endpaperTexture, .256, 1.37, 1.5, .28, Math.PI * .934);

  const finalPage = leaf(plainTexture, .246, 99, 1, 0, 0);
  const finalMaterial = finalPage.material as THREE.MeshStandardMaterial;
  const inkReveal = { value: 0 };
  const inkMaterialCompile = finalMaterial.onBeforeCompile.bind(finalMaterial);
  finalMaterial.onBeforeCompile = (shader, gl) => {
    inkMaterialCompile(shader, gl);
    shader.uniforms.uInk = { value: inkTexture };
    shader.uniforms.uReveal = inkReveal;
    shader.uniforms.uInkMask = { value: inkMask };
    shader.fragmentShader = `
      uniform sampler2D uInk;
      uniform sampler2D uInkMask;
      uniform float uReveal;
      float paperNoise(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float pigmentAt(vec2 uv) {
        vec2 deposit = texture2D(uInkMask, uv).rg;
        // Older deposits spread farther into the paper; fresh ink stays concentrated.
        return deposit.r * mix(1.0, .50, deposit.g);
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      vec4 ink = texture2D(uInk, vMapUv);
      float fiber = paperNoise(floor(vMapUv * vec2(1700.0, 2300.0)));
      float coarse = paperNoise(floor(vMapUv * vec2(260.0, 380.0)));
      vec2 texel = vec2(1.0 / 768.0, 1.0 / 1024.0);
      vec2 seepUv = vMapUv + (vec2(fiber, coarse) - .5) * texel * 1.35;
      vec2 deposit = texture2D(uInkMask, seepUv).rg;
      vec2 r = texel * (1.6 + coarse * 1.8);
      float halo = 0.0;
      halo += pigmentAt(seepUv + vec2(r.x, 0.0));
      halo += pigmentAt(seepUv - vec2(r.x, 0.0));
      halo += pigmentAt(seepUv + vec2(0.0, r.y));
      halo += pigmentAt(seepUv - vec2(0.0, r.y));
      halo += pigmentAt(seepUv + r * .707);
      halo += pigmentAt(seepUv - r * .707);
      halo += pigmentAt(seepUv + vec2(r.x, -r.y) * .707);
      halo += pigmentAt(seepUv + vec2(-r.x, r.y) * .707);
      halo *= .125;
      float outer = pigmentAt(seepUv + r * 1.75) + pigmentAt(seepUv - r * 1.75)
                  + pigmentAt(seepUv + vec2(r.x, -r.y) * 1.75) + pigmentAt(seepUv + vec2(-r.x, r.y) * 1.75);
      outer *= .25;
      float density = deposit.r * (.98 + fiber * .02);
      float bleeding = (halo * .42 + outer * .14) * (.55 + fiber * .45);
      float coverage = clamp(density + bleeding * (1.0 - density), 0.0, 1.0);
      vec3 inkColor = mix(vec3(.032, .038, .031), vec3(.006, .013, .009), deposit.g);
      diffuseColor.rgb = mix(diffuseColor.rgb, inkColor, coverage);
      diffuseColor.rgb *= mix(vec3(1.0), ink.rgb, ink.a * uReveal);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      vec2 wetInk = texture2D(uInkMask, vMapUv).rg;
      roughnessFactor = mix(roughnessFactor, .48, wetInk.r * wetInk.g);
    `);
  };
  finalMaterial.customProgramCacheKey = () => 'munhae-ink-page-v1';

  // Four hand-sewn stations, with a longitudinal thread along the spine.
  const threadMaterial = new THREE.MeshStandardMaterial({ color: '#bca878', roughness: 1 });
  for (const z of [-1.03, -.36, .36, 1.03]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(.10, .27, z), new THREE.Vector3(-.065, .24, z - .015),
      new THREE.Vector3(-.08, .02, z), new THREE.Vector3(.10, -.066, z),
    ]);
    const thread = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, .010, 6, false), threadMaterial);
    thread.castShadow = true; book.add(thread);
  }
  const spineCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(-.055, .05, -1.06), new THREE.Vector3(-.066, .03, 0), new THREE.Vector3(-.055, .05, 1.06)]);
  book.add(new THREE.Mesh(new THREE.TubeGeometry(spineCurve, 28, .009, 6, false), threadMaterial));

  let lastSeconds = 0, lastX = 0, lastY = 0, lastDetail = 0;
  function render(seconds: number, pointerX = 0, pointerY = 0, detail = 0) {
    if (disposed) return;
    lastSeconds = seconds; lastX = pointerX; lastY = pointerY; lastDetail = detail;
    const opening = ease((seconds - .22) / 1.65);
    coverHinge.rotation.z = opening * Math.PI * .98;
    turns.forEach(turn => { turn.uniforms.uTurn.value = ease((seconds - turn.start) / turn.duration) * turn.end; });
    inkReveal.value = ease((seconds - WRITING_END) / .7);
    if (calligraphy.update(seconds)) inkMask.needsUpdate = true;
    const settle = ease(seconds / 3.4);
    book.position.x = -.98 * (1 - opening);
    book.position.y = .47 + Math.sin(seconds * 1.3) * .035;
    book.rotation.set(.045 + pointerY * .018, -.25 + settle * .12 + pointerX * .025, -.035);
    const writing = ease((seconds - WRITING_START + .5) / 1.2);
    camera.position.set(
      THREE.MathUtils.lerp(3.0 - settle * .7 - writing * .5, 1.6, detail),
      THREE.MathUtils.lerp(7.8, 7.4, detail),
      THREE.MathUtils.lerp(8.6 - settle * .7 - writing * .5, 2.8, detail),
    );
    camera.lookAt(detail * .88, .1 + detail * .35, 0);
    softShadow.position.x = book.position.x + W / 2 * (1 - opening);
    softShadow.scale.x = .6 + opening * .4;
    renderer.render(scene, camera);
  }
  function resize() {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(width, height, false); camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix(); render(lastSeconds, lastX, lastY, lastDetail);
  }
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  host.classList.add('is-ready');
  return {
    render,
    dispose() {
      if (disposed) return; disposed = true; observer.disconnect();
      const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>(depthMaterials);
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry);
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
        }
      });
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
      textures.forEach(texture => texture.dispose()); light.shadow.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
