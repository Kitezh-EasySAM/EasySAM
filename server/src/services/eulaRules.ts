/**
 * Проверка лицензии правилами (без модели): распознать лицензию (MIT, GPL, Apache…), найти ограничения
 * («только для личного использования», пробный период, подписка, аудит) и вынести вердикт. Тесты: test/eula.test.ts
 */
import type { CommercialUse, EulaAnalysis, LicenseKind, Verdict } from "./eula.ts";

export const LICENSES: { re: RegExp; name: string; kind: LicenseKind; commercial: CommercialUse; copyleft: boolean }[] =
  [
    {
      re: /GNU\s+(LESSER|LIBRARY)\s+GENERAL\s+PUBLIC|\bLGPL/i,
      name: "GNU LGPL",
      kind: "open_source",
      commercial: "allowed",
      copyleft: true,
    },
    { re: /GNU\s+AFFERO|\bAGPL/i, name: "GNU AGPL", kind: "open_source", commercial: "allowed", copyleft: true },
    {
      re: /GNU\s+GENERAL\s+PUBLIC\s+LICEN[CS]E[\s\S]{0,40}VERSION\s*3|\bGPL-?3|GPLv3/i,
      name: "GNU GPL v3",
      kind: "open_source",
      commercial: "allowed",
      copyleft: true,
    },
    {
      re: /GNU\s+GENERAL\s+PUBLIC|\bGPL\b|GPLv2/i,
      name: "GNU GPL",
      kind: "open_source",
      commercial: "allowed",
      copyleft: true,
    },
    {
      re: /MOZILLA\s+PUBLIC\s+LICEN[CS]E|\bMPL[- ]?2/i,
      name: "Mozilla Public License 2.0",
      kind: "open_source",
      commercial: "allowed",
      copyleft: true,
    },
    {
      re: /APACHE\s+LICEN[CS]E|Apache-2\.0/i,
      name: "Apache License 2.0",
      kind: "open_source",
      commercial: "allowed",
      copyleft: false,
    },
    {
      re: /\bMIT\s+LICEN[CS]E|Permission is hereby granted, free of charge/i,
      name: "MIT",
      kind: "open_source",
      commercial: "allowed",
      copyleft: false,
    },
    {
      re: /\bBSD\b[\s\S]{0,30}LICEN[CS]E|Redistribution and use in source and binary forms/i,
      name: "BSD",
      kind: "open_source",
      commercial: "allowed",
      copyleft: false,
    },
    {
      re: /ECLIPSE\s+PUBLIC\s+LICEN[CS]E|\bEPL\b/i,
      name: "Eclipse Public License",
      kind: "open_source",
      commercial: "allowed",
      copyleft: true,
    },
  ];
const RISKS: {
  re: RegExp;
  point: string;
  commercial?: CommercialUse;
  kind?: LicenseKind;
  subscription?: boolean;
  audit?: boolean;
}[] = [
  {
    re: /(personal|private|home|non-?commercial)\s+(use\s+)?only|for\s+non-?commercial\s+use|только\s+для\s+(личного|домашнего|некоммерческого)|некоммерческ[а-яё]+\s+использовани/i,
    point: "Разрешено только личное/некоммерческое использование — в организации нельзя без покупки",
    commercial: "forbidden",
  },
  {
    re: /commercial\s+use\s+(is\s+)?(prohibited|not\s+(permitted|allowed))|коммерческое\s+использование\s+(запрещено|не\s+допускается)/i,
    point: "Коммерческое использование запрещено",
    commercial: "forbidden",
  },
  {
    re: /trial|evaluation\s+(period|version|copy)|ознакомительн|пробн[а-яё]+\s+(период|верси)/i,
    point: "Пробный (ознакомительный) период — после него нужна покупка",
    kind: "trial",
  },
  { re: /shareware|условно[- ]бесплатн/i, point: "Условно-бесплатная программа (shareware)", kind: "shareware" },
  { re: /subscription|подписк/i, point: "Лицензия по подписке — нужно продлевать", subscription: true },
  {
    re: /\baudit\b|right\s+to\s+(inspect|verify)|аудит/i,
    point: "Правообладатель вправе проводить аудит использования",
    audit: true,
  },
  {
    re: /per\s+(user|device|seat|computer)|на\s+(одного\s+пользователя|одно\s+устройство|один\s+компьютер)|number\s+of\s+(users|devices)/i,
    point: "Лицензия ограничена числом пользователей/устройств",
  },
  {
    re: /may\s+not\s+(reverse\s+engineer|decompile)|запрещается\s+(декомпил|дизассембл)/i,
    point: "Запрет декомпиляции и модификации",
  },
  {
    re: /freeware|free\s+of\s+charge|бесплатн[а-яё]+\s+(для\s+всех|программ)/i,
    point: "Бесплатная (freeware)",
    kind: "freeware",
  },
];

/** Разбор текста лицензии правилами: какая лицензия, коммерческое использование, риски с цитатами. */
export function analyzeByRules(
  text: string,
): Pick<
  EulaAnalysis,
  "license_name" | "license_kind" | "commercial_use" | "copyleft" | "subscription" | "audit_rights" | "risks"
> {
  const lic = LICENSES.find((l) => l.re.test(text));
  let commercial: CommercialUse = lic?.commercial ?? "unknown";
  let kind: LicenseKind | null = lic?.kind ?? null;
  let subscription: boolean | null = null,
    audit: boolean | null = null;
  const risks: EulaAnalysis["risks"] = [];
  for (const r of RISKS) {
    const m = r.re.exec(text);
    if (!m) continue;
    if (r.kind === "freeware" && lic) continue; // «free of charge» в MIT — не про freeware
    const at = Math.max(0, m.index - 60);
    risks.push({
      point: r.point,
      quote: text
        .slice(at, m.index + m[0].length + 60)
        .replace(/\s+/g, " ")
        .trim(),
    });
    if (r.commercial) commercial = r.commercial;
    if (r.kind && !lic) kind = kind === "trial" || kind === "shareware" ? kind : r.kind;
    if (r.subscription) subscription = true;
    if (r.audit) audit = true;
  }
  if (commercial === "unknown" && kind === "freeware") commercial = "allowed";
  if (!kind && /all\s+rights\s+reserved|proprietary|лицензионн[а-яё]+\s+соглашени/i.test(text)) kind = "commercial";
  return {
    license_name: lic?.name ?? null,
    license_kind: kind,
    commercial_use: commercial,
    copyleft: lic ? lic.copyleft : null,
    subscription,
    audit_rights: audit,
    risks,
  };
}

/** Вердикт по разбору: одобрить, проверить юристом или отклонить — с текстом для человека. */
export function verdictOf(a: Pick<EulaAnalysis, "commercial_use" | "license_kind" | "risks">): {
  verdict: Verdict;
  text: string;
} {
  if (a.commercial_use === "forbidden")
    return { verdict: "reject", text: "Нельзя использовать в организации без покупки коммерческой лицензии" };
  if (a.commercial_use === "allowed" && (a.license_kind === "open_source" || a.license_kind === "freeware"))
    return { verdict: "approve", text: "Можно одобрить: коммерческое использование разрешено" };
  if (a.commercial_use === "allowed")
    return { verdict: "approve", text: "Можно одобрить при наличии купленных лицензий" };
  return { verdict: "review", text: "Нужна проверка юристом: условия использования в организации не ясны" };
}
