/**
 * Движок compliance: «куплено vs установлено» и риски. Чистая функция, без БД.
 * Правила:
 *  - installed = уникальные УСТРОЙСТВА (Java 8 и Java 8 (64-bit) на одном ПК = одна установка);
 *    агрегацию делает routes/compliance.ts.
 *  - лимит мест есть только у LICENSABLE (commercial/shareware/trial); open_source/freeware без дефицита.
 *  - приоритет статуса: forbidden > over > outdated > idle > ok.
 *  - штраф = дефицит × цена места (₽) — оценка риска, не юридическое заключение.
 *  - zombie = ПК, где платное ПО занимает место, но не запускалось > STALE_DAYS (или ни разу за это время наблюдения
 *    за процессами ПК) или владелец уволен.
 *    На статус не влияет (это не нарушение), а показывает, сколько мест можно забрать: reclaimable ₽.
 * Тесты: test/compliance.test.ts
 */
export type LicenseKind = "open_source" | "freeware" | "shareware" | "trial" | "commercial";
export type InternalStatus = "current" | "outdated" | "forbidden";
export type Status = "forbidden" | "over" | "outdated" | "idle" | "ok";
export type Severity = "red" | "yellow" | "green";

const LICENSABLE: ReadonlySet<LicenseKind> = new Set(["commercial", "shareware", "trial"]);

export interface CatalogInfo {
  id: number;
  name: string;
  licenseKind: LicenseKind;
  internalStatus: InternalStatus;
  seats: number; // куплено (действующие закупки)
  unitPrice: number; // ₽ за место
  installed: number; // уникальных устройств
  outdatedInstalled: number; // из них с версией ниже min_version
  zombie?: number; // из них «зомби» (см. выше)
}

export interface ComplianceRow {
  catalogId: number;
  name: string;
  licenseKind: LicenseKind;
  seats: number;
  installed: number;
  deficit: number; // >0: установлено больше, чем куплено
  idle: number; // >0: куплено больше, чем установлено
  penalty: number; // ₽ штрафной риск
  waste: number; // ₽ простой
  zombie: number; // ПК с неиспользуемой платной установкой
  reclaimable: number; // ₽ можно вернуть, отозвав зомби-установки
  status: Status;
  severity: Severity;
}

/** Строки compliance по каталогу: дефицит, простой, штраф, зомби и статус; отсортированы красные первыми. */
export function compute(items: CatalogInfo[]): ComplianceRow[] {
  const rows = items.map((it): ComplianceRow => {
    const licensable = LICENSABLE.has(it.licenseKind);
    const deficit = licensable ? Math.max(0, it.installed - it.seats) : 0;
    const idle = licensable ? Math.max(0, it.seats - it.installed) : 0;
    let status: Status, severity: Severity;
    if (it.internalStatus === "forbidden" && it.installed > 0) [status, severity] = ["forbidden", "red"];
    else if (deficit > 0) [status, severity] = ["over", "red"];
    else if (it.outdatedInstalled > 0 || (it.internalStatus === "outdated" && it.installed > 0))
      [status, severity] = ["outdated", "yellow"];
    else if (idle > 0) [status, severity] = ["idle", "yellow"];
    else [status, severity] = ["ok", "green"];
    return {
      catalogId: it.id,
      name: it.name,
      licenseKind: it.licenseKind,
      seats: it.seats,
      installed: it.installed,
      deficit,
      idle,
      penalty: deficit * it.unitPrice,
      waste: idle * it.unitPrice,
      zombie: licensable ? (it.zombie ?? 0) : 0,
      reclaimable: licensable ? (it.zombie ?? 0) * it.unitPrice : 0,
      status,
      severity,
    };
  });
  const order = { red: 0, yellow: 1, green: 2 } as const;
  return rows.sort(
    (a, b) => order[a.severity] - order[b.severity] || b.penalty - a.penalty || b.installed - a.installed,
  );
}

/** Итоги по всем строкам: суммы штрафа, простоя, возврата и число строк по цвету. */
export function summarize(rows: ComplianceRow[]) {
  const sum = (f: (r: ComplianceRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    totalPenalty: sum((r) => r.penalty),
    totalWaste: sum((r) => r.waste),
    totalReclaimable: sum((r) => r.reclaimable),
    zombie: sum((r) => r.zombie),
    red: rows.filter((r) => r.severity === "red").length,
    yellow: rows.filter((r) => r.severity === "yellow").length,
    green: rows.filter((r) => r.severity === "green").length,
    products: rows.length,
  };
}
