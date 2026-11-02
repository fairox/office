// three.js view of a layout. Z is up; the scene is built in mm and scaled to metres.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { wallLength, wallRect, WALLS } from './generator.js';
import { edgesOf, edgeRect } from './generator_m.js';

const COLORS = {
  floor: 0xe9e6df, wall: 0xf3f2ee, glass: 0x9fd0ea, door: 0x8a6b4a,
  desk: 0xd9c7a5, deskLeg: 0x5d636b, chair: 0x46505c, table: 0xc9b38c, booth: 0x6f9c8a, boothRoof: 0x3f5f53,
  partition: 0xe4e8ec, column: 0x9aa0a6, core: 0xb9bcc0, storage: 0x8f969e,
};

export class View3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    this.controls.addEventListener('start', () => { this.userMoved = true; });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8a83, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-4, -6, 10);
    this.scene.add(sun);
    this.root = new THREE.Group();
    this.root.scale.setScalar(0.001);
    this.scene.add(this.root);
    this.mats = {};
    this.sizeKey = '';
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  mat(key, opts = {}) {
    if (!this.mats[key]) this.mats[key] = new THREE.MeshStandardMaterial({ color: COLORS[key], roughness: 0.85, ...opts });
    return this.mats[key];
  }

  box(r, z0, z1, mat) {
    const w = r.x1 - r.x0, d = r.y1 - r.y0, h = z1 - z0;
    if (w <= 0 || d <= 0 || h <= 0) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
    m.position.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (z0 + z1) / 2);
    this.root.add(m);
  }

  update(layout) {
    for (const c of [...this.root.children]) { c.geometry.dispose(); this.root.remove(c); }
    const site = layout.site, W = site.width, D = site.depth, H = site.height, t = site.wall;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--plan-bg').trim() || '#f4f3ef';
    this.scene.background = new THREE.Color(bg);

    if (layout.tier === 'M') this.siteM(layout);
    else this.box({ x0: -t, y0: -t, x1: W + t, y1: D + t }, -20, 0, this.mat('floor'));

    // walls, split at the openings; S and N run through the corners
    for (const w of layout.tier === 'M' ? [] : WALLS) {
      const L = wallLength(site, w), ext = w === 'S' || w === 'N' ? t : 0;
      const ops = site.openings.filter((o) => o.wall === w).sort((a, b) => a.s0 - b.s0);
      let s = -ext;
      const solid = (a, b, z0, z1) => { if (b > a) this.box(wallRect(site, w, a, b, -t, 0), z0, z1, this.mat('wall')); };
      for (const o of ops) {
        solid(s, o.s0, 0, H);
        solid(o.s0, o.s1, 0, o.sill);
        solid(o.s0, o.s1, o.sill + o.height, H);
        if (o.kind === 'window') {
          this.box(wallRect(site, w, o.s0, o.s1, -t / 2 - 8, -t / 2 + 8), o.sill, o.sill + o.height,
            this.mat('glass', { transparent: true, opacity: 0.35, roughness: 0.1 }));
        } else {
          const sh = o.hinge === 'end' ? o.s1 - 40 : o.s0, lw = o.s1 - o.s0;
          const [n0, n1] = o.swing === 'out' ? [-t - lw, -t] : [0, lw];
          this.box(wallRect(site, w, sh, sh + 40, n0, n1), 0, o.height, this.mat('door'));
        }
        s = Math.max(s, o.s1);
      }
      solid(s, L + ext, 0, H);
    }

    for (const e of layout.elements) {
      if (e.kind === 'desk') {
        this.box(e, e.h - 25, e.h, this.mat('desk'));
        const alongX = e.rot % 180 === 0;
        const ends = alongX
          ? [{ ...e, x1: e.x0 + 30 }, { ...e, x0: e.x1 - 30 }]
          : [{ ...e, y1: e.y0 + 30 }, { ...e, y0: e.y1 - 30 }];
        for (const p of ends) this.box(p, 0, e.h - 25, this.mat('deskLeg'));
      } else if (e.kind === 'table' && e.shape === 'round') {
        const top = new THREE.Mesh(new THREE.CylinderGeometry((e.x1 - e.x0) / 2, (e.x1 - e.x0) / 2, 30, 48), this.mat('table'));
        top.rotation.x = Math.PI / 2;
        top.position.set((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2, e.h - 15);
        this.root.add(top);
        const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
        this.box({ x0: cx - 120, y0: cy - 120, x1: cx + 120, y1: cy + 120 }, 0, e.h - 30, this.mat('deskLeg'));
      } else if (e.kind === 'table') {
        this.box(e, e.h - 30, e.h, this.mat('table'));
        const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
        this.box({ x0: cx - 150, y0: cy - 150, x1: cx + 150, y1: cy + 150 }, 0, e.h - 30, this.mat('deskLeg'));
      } else if (e.kind === 'partition') {
        this.box(e, 0, H, this.mat('partition', { transparent: true, opacity: 0.85 }));
      } else if (e.kind === 'column') {
        this.box(e, 0, H, this.mat('column'));
      } else if (e.kind === 'core') {
        this.box(e, 0, H, this.mat('core', { transparent: true, opacity: 0.55 }));
      } else if (e.kind === 'storage') {
        this.box(e, 0, e.h, this.mat('storage'));
      } else if (e.kind === 'booth') {
        this.box(e, 0, e.h - 60, this.mat('booth', { transparent: true, opacity: 0.8 }));
        this.box(e, e.h - 60, e.h, this.mat('boothRoof'));
      } else if (e.kind === 'chair') {
        const seat = { x0: e.x0 + 40, y0: e.y0 + 40, x1: e.x1 - 40, y1: e.y1 - 40 };
        this.box(seat, 420, 470, this.mat('chair'));
        // the back sits on the chair's local -y side, rotated by e.rot
        const a = (e.rot * Math.PI) / 180, dx = Math.round(Math.sin(a)), dy = Math.round(-Math.cos(a));
        const back = dx > 0 ? { ...seat, x0: seat.x1 - 60 } : dx < 0 ? { ...seat, x1: seat.x0 + 60 }
          : dy > 0 ? { ...seat, y0: seat.y1 - 60 } : { ...seat, y1: seat.y0 + 60 };
        this.box(back, 470, e.h, this.mat('chair'));
      }
    }

    const bb = site.bbox || { x0: 0, y0: 0, x1: W, y1: D };
    this.room = { x0: bb.x0, y0: bb.y0, W: bb.x1 - bb.x0, D: bb.y1 - bb.y0, H };
    const key = `${bb.x0},${bb.y0},${W}x${D}x${H}`;
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      this.userMoved = false;
      this.fit();
    }
    this.render();
  }

  // Frame the whole room from the south-east, accounting for the pane's aspect ratio.
  fit() {
    if (!this.room) return;
    const { x0, y0, W, D, H } = this.room;
    const R = Math.hypot(W, D, H) / 2000;
    const v = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const h = Math.atan(Math.tan(v) * this.camera.aspect);
    const dist = (R / Math.sin(Math.min(v, h))) * 0.95;
    const dir = new THREE.Vector3(0.4, -0.75, 0.75).normalize();
    const target = new THREE.Vector3((x0 + W / 2) / 1000, (y0 + D / 2) / 1000, 0.3);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }

  // Tier M: floor slab from the outline; walls along each edge, split at openings, extended into convex corners.
  siteM(layout) {
    const site = layout.site, poly = site.outline, t = site.wall, H = site.height, edges = edgesOf(poly);
    const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const floor = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 20, bevelEnabled: false }), this.mat('floor'));
    floor.position.z = -20;
    this.root.add(floor);
    edges.forEach((e, i) => {
      const next = edges[(i + 1) % edges.length];
      const convexEnd = e.dir[0] * next.dir[1] - e.dir[1] * next.dir[0] > 0;
      const ops = site.openings.filter((o) => o.edge === i).sort((a, b) => a.s0 - b.s0);
      const solid = (a, b, z0, z1) => { if (b > a) this.box(edgeRect(e, a, b, -t, 0), z0, z1, this.mat('wall')); };
      let s = 0;
      for (const o of ops) {
        solid(s, o.s0, 0, H);
        solid(o.s0, o.s1, 0, o.sill);
        solid(o.s0, o.s1, o.sill + o.height, H);
        if (o.kind === 'window') this.box(edgeRect(e, o.s0, o.s1, -t / 2 - 8, -t / 2 + 8), o.sill, o.sill + o.height, this.mat('glass', { transparent: true, opacity: 0.35, roughness: 0.1 }));
        s = Math.max(s, o.s1);
      }
      solid(s, e.L + (convexEnd ? t : 0), 0, H);
    });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.fit();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
