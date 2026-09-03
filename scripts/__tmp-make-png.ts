import { mkdirSync, writeFileSync } from 'node:fs';

import { makePng } from '../tests/fixtures/images.ts';

mkdirSync('.wrangler/incoming', { recursive: true });
writeFileSync('.wrangler/incoming/sofa-1.png', makePng(1200, 800));
writeFileSync('.wrangler/incoming/sofa-2.png', makePng(900, 600));
console.log('written');
