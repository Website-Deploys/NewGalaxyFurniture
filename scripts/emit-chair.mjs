import sharp from 'sharp';

const src = 'reviews-chair-crop.png';
const meta = await sharp(src).metadata();
console.log('crop source', meta.width, meta.height);

// Emit responsive WebP derivatives on a cream matte, matching the card ground so the
// chair reads as sitting on the card, not on a hard-edged rectangle.
const CREAM = { r: 243, g: 239, b: 232 }; // --color-cream #F3EFE8
for (const w of [480, 768, 960]) {
  const out = `public/brand/reviews-empty-chair-${w}.webp`;
  await sharp(src)
    .resize({ width: w })
    .flatten({ background: CREAM })
    .webp({ quality: 82 })
    .toFile(out);
  const m = await sharp(out).metadata();
  console.log('wrote', out, m.width, m.height);
}
