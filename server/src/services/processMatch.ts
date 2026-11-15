/**
 * Сопоставление процесса с программой (installer → path → installed → exe → product → fuzzy) — порядок и смысл в
 * шапке processes.ts. Тесты: test/processes.test.ts
 */
import type { DB } from "../db.ts";
import { suggest } from "./fuzzy.ts";
import { buildMatcher } from "./ingest.ts";
import { normalizeName } from "./normalize.ts";
import { loadCandidates } from "./unmatched.ts";
import type { ProcIn } from "./processes.ts";
/** Путь Windows в едином виде: обратные слэши, нижний регистр. */
export const winPath = (p: string) => p.replace(/\//g, "\\").toLowerCase();
/** exe → имя позиции каталога (+ проверка издателя, где exe-имя неоднозначно). */
const EXE_MAP: [RegExp, string, RegExp?][] = [
  [/^(winword|excel|powerpnt|outlook|msaccess|mspub)\.exe$/i, "Microsoft Office"],
  [/^visio\.exe$/i, "Microsoft Visio"],
  [/^winproj\.exe$/i, "Microsoft Project"],
  [/^acad(lt)?\.exe$/i, "Autodesk AutoCAD"],
  [/^photoshop\.exe$/i, "Adobe Photoshop"],
  [/^acrobat\.exe$/i, "Adobe Acrobat Pro"],
  [/^acrord32\.exe$/i, "Adobe Acrobat Reader"],
  [/^(winrar|rar|unrar)\.exe$/i, "WinRAR"],
  [/^chrome\.exe$/i, "Google Chrome", /google/i],
  [/^7z(fm|g)?\.exe$/i, "7-Zip"],
  [/^(saplogon|sapgui)\.exe$/i, "SAP GUI for Windows"],
  [/^(avp|avpui)\.exe$/i, "Kaspersky Endpoint Security"],
  [/^javaw?\.exe$/i, "Oracle Java SE", /oracle/i],
  [/^far\.exe$/i, "Far Manager 3"],
];

const PROGRAM_FILES = /^[a-z]:\\program files( \(x86\))?\\/i;
export const SYSTEM_PATH = /^[a-z]:\\windows\\/i;
/** Системные процессы, которые старый агент присылал без пути (без прав администратора путь не виден). */
export const SYSTEM_EXE = new Set([
  "system",
  "registry",
  "idle",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "svchost.exe",
  "dwm.exe",
  "fontdrvhost.exe",
  "spoolsv.exe",
  "sppsvc.exe",
  "dllhost.exe",
  "msdtc.exe",
  "wmiprvse.exe",
  "searchindexer.exe",
  "searchfilterhost.exe",
  "searchprotocolhost.exe",
  "aggregatorhost.exe",
  "mousocoreworker.exe",
  "conhost.exe",
  "sihost.exe",
  "taskhostw.exe",
  "runtimebroker.exe",
  "ctfmon.exe",
  "explorer.exe",
]);

export interface ProcMatch {
  catalog_id: number | null;
  installation_name: string | null;
  method: string | null;
  portable: boolean;
}

const INSTALLER_EXE =
  /(^|[-_. ])(setup|install|installer|uninstall|uninst|unins\d*)([-_. ]|\.exe$)|^(setup|install)\.exe$/i;
const INSTALLER_PRODUCT = /\b(setup|installer|uninstall(er)?)\b|установ(щик|ка)/i;
const INSTALLER_CAMEL = /[a-z0-9](Setup|Installer|Install|Uninstall|Uninstaller)(\d|[-_. ]|\.exe$)/; // ChromeSetup.exe, OneDriveSetup.exe
/** Процесс — установщик или деинсталлятор (не программа, не portable). */
export const isInstaller = (p: ProcIn) =>
  INSTALLER_EXE.test(p.exe) || INSTALLER_CAMEL.test(p.exe) || INSTALLER_PRODUCT.test(p.product_name ?? "");

/** С какой программой связан процесс и portable ли он (порядок проверок — в шапке processes.ts). */
export function matchProcess(db: DB, serial: string, p: ProcIn, ctx = buildContext(db, serial)): ProcMatch {
  if (isInstaller(p)) return { catalog_id: null, installation_name: null, method: "installer", portable: false };
  const path = p.path ? winPath(p.path) : null;
  // 1) по пути установленной программы (самая длинная подходящая папка)
  if (path) {
    let best: (typeof ctx.installs)[number] | null = null;
    for (const i of ctx.installs) if (path.startsWith(i.loc) && (!best || i.loc.length > best.loc.length)) best = i;
    if (best) return { catalog_id: best.catalog_id, installation_name: best.raw_name, method: "path", portable: false };
  }
  // 1b) ProductName exe = название программы, установленной на этом ПК
  if (p.product_name?.trim()) {
    const pn = normalizeName(p.product_name);
    const inst = ctx.installedByName.get(pn);
    if (inst)
      return { catalog_id: inst.catalog_id, installation_name: inst.raw_name, method: "installed", portable: false };
  }
  let catalogId: number | null = null,
    method: string | null = null;
  // 2) словарь exe
  for (const [re, name, company] of EXE_MAP)
    if (re.test(p.exe) && (!company || company.test(p.company ?? "")) && ctx.catalogByName.has(name.toLowerCase())) {
      catalogId = ctx.catalogByName.get(name.toLowerCase())!;
      method = "exe";
      break;
    }
  // 3–4) ProductName из exe
  if (catalogId === null && p.product_name?.trim()) {
    const m = ctx.match(normalizeName(p.product_name));
    if (m) {
      catalogId = m.catalogId;
      method = "product";
    } else {
      const s = suggest(normalizeName(p.product_name), p.company ?? null, ctx.candidates, 1, 0.9)[0];
      if (s) {
        catalogId = s.catalog_id;
        method = "fuzzy";
      }
    }
  }
  const installedHere = catalogId !== null && ctx.installedCatalog.has(catalogId);
  const portable = !installedHere && !(path && PROGRAM_FILES.test(path));
  return { catalog_id: catalogId, installation_name: null, method, portable };
}

/** Установки ПК и данные каталога для сопоставления процессов этого ПК (строится один раз на отчёт). */
export function buildContext(db: DB, serial: string) {
  const rows = db
    .prepare("SELECT raw_name, catalog_id, install_location FROM installation WHERE device_serial = ? AND is_noise = 0")
    .all(serial) as { raw_name: string; catalog_id: number | null; install_location: string | null }[];
  const installedByName = new Map<string, (typeof rows)[number]>();
  for (const r of rows)
    if (!installedByName.has(normalizeName(r.raw_name))) installedByName.set(normalizeName(r.raw_name), r);
  return {
    installedByName,
    installs: rows
      .filter((r) => r.install_location && r.install_location.trim().length > 3)
      .map((r) => ({ ...r, loc: winPath(r.install_location!).replace(/\\?$/, "\\") })),
    installedCatalog: new Set(rows.map((r) => r.catalog_id).filter((x): x is number => x !== null)),
    catalogByName: new Map(
      (db.prepare("SELECT id, name FROM software_catalog").all() as { id: number; name: string }[]).map((c) => [
        c.name.toLowerCase(),
        c.id,
      ]),
    ),
    match: buildMatcher(db),
    candidates: loadCandidates(db),
  };
}
