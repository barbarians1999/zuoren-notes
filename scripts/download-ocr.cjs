const fs = require('node:fs/promises');
const path = require('node:path');

const out = path.resolve(__dirname, '..', 'public', 'ocr');
const base = 'https://tessdata.projectnaptha.com/4.0.0';
const languages = ['eng', 'chi_sim', 'chi_tra'];

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  for (const language of languages) {
    const target = path.join(out, `${language}.traineddata.gz`);
    try { await fs.access(target); console.log(`exists ${target}`); }
    catch { console.log(`download ${language}`); await download(`${base}/${language}.traineddata.gz`, target); }
  }
  console.log(`OCR resources ready: ${out}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
