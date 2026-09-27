import sharp from 'sharp';

const src = 'public/brand/home-reviews-scene-1973.webp';
const meta = await sharp(src).metadata();
console.log('source', meta.width, meta.height);

// Crop box expressed as fractions of the composite, tuned to the chair + throw + plant on the card.
const fx = Number(process.argv[2] ?? 0.395);
const fy = Number(process.argv[3] ?? 0.28);
const fw = Number(process.argv[4] ?? 0.215);
const fh = Number(process.argv[5] ?? 0.36);

const left = Math.round(meta.width * fx);
const top = Math.round(meta.height * fy);
const width = Math.round(meta.width * fw);
const height = Math.round(meta.height * fh);
console.log('crop', { left, top, width, height });

await sharp(src)
  .extract({ left, top, width, height })
  .toFile('reviews-chair-crop.png');
console.log('wrote reviews-chair-crop.png');
