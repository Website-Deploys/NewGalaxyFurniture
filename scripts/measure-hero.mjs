import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(process.cwd(), 'dist');
const PORT = 4404;
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain' };
async function tryFiles(u){const clean=decodeURIComponent(u.split('?')[0]);const rel=normalize(clean).replace(/^(\.\.[/\\])+/,'');for(const p of [join(ROOT,rel),join(ROOT,rel,'index.html')]){try{if((await stat(p)).isFile())return p;}catch{}}return null;}
const server=http.createServer(async(req,res)=>{const f=await tryFiles(req.url==='/'?'/index.html':req.url);if(!f){res.statusCode=404;res.end('nf');return;}res.setHeader('Content-Type',MIME[extname(f)]??'application/octet-stream');res.end(await readFile(f));});
await new Promise(r=>server.listen(PORT,r));
const browser=await chromium.launch();
for (const [label, vp] of [['mobile',{width:390,height:844,deviceScaleFactor:2,isMobile:true}],['desktop',{width:1440,height:900,deviceScaleFactor:1}]]) {
  const page=await browser.newPage({viewport:vp});
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:'networkidle'});
  const data=await page.evaluate(()=>{
    const header=document.querySelector('.ngf-header');
    const inner=document.querySelector('.ngf-header-inner');
    const hero=document.querySelector('.ngf-hero');
    const panel=document.querySelector('.ngf-hero-panel');
    const r=(el)=>{const b=el.getBoundingClientRect();return {top:Math.round(b.top),height:Math.round(b.height)};};
    return {
      header: header?r(header):null,
      inner: inner?r(inner):null,
      hero: hero?r(hero):null,
      panel: panel?r(panel):null,
      heroMarginTop: hero?getComputedStyle(hero).marginTop:null,
    };
  });
  console.log(label, JSON.stringify(data));
  await page.close();
}
await browser.close(); server.close(); process.exit(0);
