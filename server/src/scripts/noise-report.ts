/** `make noise-report`: доля шума в реальной выгрузке + что просочилось (для подбора правил). */
import { isNoise } from "../services/normalize.ts";
import { readHostRows } from "./materials.ts";

const rows = await readHostRows();
const noise = rows.filter((r) => isNoise(r.name)).length;
const keep = new Map<string, number>();
for (const r of rows) if (!isNoise(r.name)) keep.set(r.name, (keep.get(r.name) ?? 0) + 1);
console.log(`строк: ${rows.length}, хостов: ${new Set(rows.map((r) => r.serial)).size}`);
console.log(`шум: ${noise} (${Math.round((noise / rows.length) * 100)}%); уник. имён-кандидатов: ${keep.size}`);
console.log("\nТоп-40 НЕ признанного шумом:");
for (const [n, c] of [...keep].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(c).padStart(5), n);
