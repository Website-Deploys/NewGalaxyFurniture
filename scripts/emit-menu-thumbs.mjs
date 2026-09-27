import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import sharp from 'sharp';

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node scripts/emit-menu-thumbs.mjs "<source folder>"');
  process.exit(1);
}

// Source filename (in the provided folder) -> category slug (public/categories/<slug>/menu.webp).
const MAP = [
  ['01_sofas_sectionals.png', 'sofas'],
  ['02_beds.png', 'beds'],
  ['03_dining_tables.png', 'dining-tables'],
  ['04_dining_chairs.png', 'dining-chairs'],
  ['05_accent_chairs.png', 'accent-chairs'],
  ['06_coffee_side_tables.png', 'coffee-side-tables'],
  ['07_storage_display.png', 'storage-display'],
  ['08_office.png', 'office'],
  ['09_outdoor.png', 'outdoor'],
  ['10_shoe_stands.png', 'shoe-stands'],
  ['11_temples.png', 'temples'],
];

const OUT_ROOT = join(process.cwd(), 'public', 'categories');
const SIZE = 240; // square thumbnail edge (px)

for (const [file, slug] of MAP) {
  const src = join(SRC, file);
  const out = join(OUT_ROOT, slug, 'menu.webp');
  await mkdir(dirname(out), { recursive: true });

  // Trim the near-uniform dark padding around the furniture so the object fills the frame the way
  // the reference shows it, then fit it into a square WebP. The residual background is the same
  // deep espresso as the menu ground, so no box seam shows.
  await sharp(src)
    .trim({ threshold: 20 })
    .resize(SIZE, SIZE, {
      fit: 'contain',
      background: { r: 28, g: 25, b: 22 }, // #1c1916 — the menu ground
    })
    .webp({ quality: 90 })
    .toFile(out);

  console.log(`wrote ${out} (from ${file})`);
}

console.log('done');

// The tall right-side showroom strip (arch, plant, vase, armchair) that bleeds behind the menu.
const scene = join(SRC, '12_right_side_showroom_background.png');
const sceneOut = join(process.cwd(), 'public', 'brand', 'menu-scene.webp');
await sharp(scene)
  .resize({ width: 640, withoutEnlargement: true })
  .webp({ quality: 82 })
  .toFile(sceneOut);
console.log(`wrote ${sceneOut}`);
