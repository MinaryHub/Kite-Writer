// node diff.mjs <out dir> name [-v]  — 한글 PDF 와 Kite PDF 의 줄(글자 줄 위치)을 쪽마다 견준다
import fs from 'node:fs';
import path from 'node:path';
const [dir, name, verbose] = process.argv.slice(2);
const { ref, kite } = JSON.parse(fs.readFileSync(path.join(dir, name + '.lines.json'), 'utf8'));
const norm = (s) => s.replace(/\s+/g, '');
let totalRef = 0, matched = 0, sumDy = 0, maxDy = 0, sumDx = 0, moved = 0;
const n = Math.max(ref.length, kite.length);
for (let p = 0; p < n; p++) {
  const a = ref[p] || [], b = kite[p] || [];
  const used = new Set();
  let pm = 0, pdy = 0, pmax = 0;
  const miss = [];
  for (const l of a) {
    totalRef++;
    const t = norm(l.t);
    // 같은 글의 줄 (가장 가까운 것)
    let best = -1, bd = 1e9;
    b.forEach((k, i) => { if (!used.has(i) && norm(k.t) === t) { const d = Math.abs(k.y - l.y) + Math.abs(k.x - l.x) * 0.2; if (d < bd) { bd = d; best = i; } } });
    if (best < 0) { miss.push(l); continue; }
    used.add(best);
    const dy = b[best].y - l.y, dx = b[best].x - l.x;
    matched++; pm++; pdy += Math.abs(dy); pmax = Math.max(pmax, Math.abs(dy)); sumDy += Math.abs(dy); sumDx += Math.abs(dx); maxDy = Math.max(maxDy, Math.abs(dy));
    if (Math.abs(dy) > 3 || Math.abs(dx) > 3) { moved++; if (verbose) console.log(`  p${p + 1} dy=${dy.toFixed(1)} dx=${dx.toFixed(1)} y=${l.y} | ${l.t.slice(0, 50)}`); }
  }
  console.log(`p${p + 1}: hangul ${a.length} lines, kite ${b.length}, same-text ${pm}, avg|dy| ${(pm ? pdy / pm : 0).toFixed(1)}pt, max ${pmax.toFixed(1)}pt` + (a[0] ? `  first: "${a[0].t.slice(0, 24)}" / "${(b[0]?.t || '').slice(0, 24)}"` : ''));
  if (verbose) for (const l of miss.slice(0, 12)) console.log(`  p${p + 1} MISSING y=${l.y} x=${l.x} | ${l.t.slice(0, 60)}`);
}
console.log(`${name}: lines ${totalRef}, same text on same page ${matched} (${((matched / Math.max(1, totalRef)) * 100).toFixed(0)}%), off by >3pt ${moved}, avg|dy| ${(sumDy / Math.max(1, matched)).toFixed(2)}pt, avg|dx| ${(sumDx / Math.max(1, matched)).toFixed(2)}pt, max|dy| ${maxDy.toFixed(1)}pt`);
