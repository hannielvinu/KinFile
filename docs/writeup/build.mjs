// Render docs/writeup/writeup.html to docs/Kinfile_Writeup.pdf (needs Playwright + Chromium):
//   npx -y playwright@1 install chromium   (once)
//   node docs/writeup/build.mjs
// Or open writeup.html in Chrome and use Print → Save as PDF (A4, default margins).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(here, 'writeup.html')).href);
const out = path.join(here, '..', 'Kinfile_Writeup.pdf');
await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log('wrote', out);
