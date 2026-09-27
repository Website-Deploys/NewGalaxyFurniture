import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(process.cwd(), 'dist');
const PORT = 4405;
const OUT = process.argv[2] ?? 'slide2-desktop.png';
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain' };
async function tryFiles(u){const clean=decodeURIComponent(u.split('?')[0]);const rel=normalize(clean).replace(/^(\.\.[/\\])+/,'');for(const p of [join(ROOT,rel),join(ROOT,rel,'index.html')]){try{if((await stat(p)).isFile())return p;}catch{}}return null;}
const server=http.createServer(async(req,res)=>{const f=await tryFiles(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;res.end('nf');return;}res.setHeader('Content-Type',MIME[extname(f)]??'application/octet-stream');res.end(await readFile(f));});
await new Promise(r=>server.listen(PORT,r));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:900,deviceScaleFactor:1}});
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'networkidle'});
const dot=await page.$('[data-hero-dot="1"]');
if(dot){await dot.click();}else{console.log('no second dot');}
await page.waitForTimeout(800);
await page.screenshot({path:OUT,fullPage:false});
console.log(`wrote ${OUT}`);
await browser.close(); server.close(); process.exit(0);
