import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(process.cwd(), 'dist');
const PORT = 4406;
const OUT = process.argv[2] ?? 'menu-open.png';
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain' };
async function tryFiles(u){const clean=decodeURIComponent(u.split('?')[0]);const rel=normalize(clean).replace(/^(\.\.[/\\])+/,'');for(const p of [join(ROOT,rel),join(ROOT,rel,'index.html')]){try{if((await stat(p)).isFile())return p;}catch{}}return null;}
const server=http.createServer(async(req,res)=>{const f=await tryFiles(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;res.end('nf');return;}res.setHeader('Content-Type',MIME[extname(f)]??'application/octet-stream');res.end(await readFile(f));});
await new Promise(r=>server.listen(PORT,r));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true}});
await page.goto(`http://localhost:${PORT}/`,{waitUntil:'networkidle'});
await page.waitForTimeout(400);
const toggle=await page.$('.ngf-mobilenav-toggle');
if(toggle){await toggle.click();await page.waitForTimeout(500);}else{console.log('no toggle');}
await page.screenshot({path:OUT,fullPage:false});
console.log(`wrote ${OUT}`);
// also a full-length capture of the panel
await page.screenshot({path:OUT.replace('.png','-full.png'),fullPage:true});
console.log('wrote full');
await browser.close(); server.close(); process.exit(0);
