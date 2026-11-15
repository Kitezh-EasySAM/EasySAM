/** `make watch`: живая лента /api/stream в терминале (для тестов агента без фронтенда). SAM_URL=http://host:8000 */
const base = process.env.SAM_URL ?? "http://localhost:8000";
const RED = "\x1b[31;1m",
  DIM = "\x1b[2m",
  OFF = "\x1b[0m";
const time = () => new Date().toLocaleTimeString("ru-RU");

for (;;) {
  try {
    const res = await fetch(`${base}/api/stream`);
    console.log(`${DIM}${time()} подключено к ${base}/api/stream — жду событий (Ctrl+C — выход)${OFF}`);
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body!) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.*)$/m)?.[1];
        const raw = block.match(/^data: (.*)$/m)?.[1];
        if (!ev || !raw) continue;
        const d = JSON.parse(raw);
        if (ev === "install") {
          const ver =
            d.type === "updated" ? `${d.old_version} → ${d.new_version}` : (d.new_version ?? d.old_version ?? "");
          const what = `${d.type.padEnd(9)} ${d.raw_name} ${ver}`.trim();
          const where = `${d.hostname ?? d.device_serial}${d.employee ? ` (${d.employee})` : ""}`;
          const cat = d.catalog_name
            ? `[${d.catalog_name}${d.internal_status === "forbidden" ? ", ЗАПРЕЩЕНО" : ""}]`
            : "[не в каталоге]";
          console.log(`${time()} ${where}: ${what} ${DIM}${cat}${OFF}`);
          if (d.alert) console.log(`${RED}         ⚠ ${d.alert.text}${OFF}`);
        } else if (ev === "ingest") {
          console.log(
            `${time()} ${DIM}загрузка (${d.source}): ПК ${d.devices}, программ ${d.rows_total}, событий ${d.events}${OFF}`,
          );
        } else if (ev === "license") {
          const color = d.alert.level === "red" ? RED : "\x1b[33;1m";
          console.log(`${time()} ${d.hostname ?? d.device_serial}: лицензия ${d.application} «${d.product}»`);
          console.log(`${color}         ⚠ ${d.alert.text}${OFF}`);
        } else if (ev === "process") {
          const color = d.alert.level === "red" ? RED : "\x1b[33;1m";
          console.log(
            `${time()} ${d.hostname ?? d.device_serial}: запущен ${d.exe}${d.catalog_name ? ` [${d.catalog_name}]` : ""}`,
          );
          console.log(`${color}         ⚠ ${d.alert.text}${OFF}`);
        } else if (ev === "command") {
          console.log(`${time()} ${d.ok ? "\x1b[32;1m✔" : RED + "✖"} ${d.text}${OFF}`);
        } else if (ev === "changed") {
          console.log(`${time()} ${DIM}изменено: ${d.method} ${d.path}${OFF}`);
        }
      }
    }
  } catch (e) {
    console.log(`${DIM}${time()} нет связи с ${base} (${(e as Error).message}), повтор через 2 с${OFF}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
