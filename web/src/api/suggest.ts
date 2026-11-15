import { useMemo } from "react";
import type { Option } from "../components/ui/index.ts";
import { useApi } from "./hooks.ts";
import type { CatalogItem, Employee, LicenseType, Purchase, Unmatched } from "./types.ts";

const uniq = (xs: (string | null | undefined)[], hint?: (x: string) => string | undefined): Option[] => {
  const count = new Map<string, number>();
  for (const x of xs) if (x?.trim()) count.set(x.trim(), (count.get(x.trim()) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).map(([v]) => ({ value: v, label: v, hint: hint?.(v) }));
};

/**
 * Подсказки для форм ввода из уже имеющихся данных: отделы, вендоры, договоры, соглашения,
 * а для нового ПО — названия из «Неопознанного» (с издателем и числом ПК; издатель дозаполняет «Вендор»).
 * enabled=false — ничего не грузить (форма закрыта).
 */
export function useSuggestions(enabled = true) {
  const emps = useApi<Employee[]>(enabled ? "/api/employees" : null, false);
  const catalog = useApi<{ items: CatalogItem[] }>(enabled ? "/api/catalog?limit=500" : null, false);
  const unknown = useApi<Unmatched>(enabled ? "/api/unmatched?limit=300" : null, false);
  const purchases = useApi<Purchase[]>(enabled ? "/api/purchases" : null, false);
  const types = useApi<LicenseType[]>(enabled ? "/api/license-types" : null, false);
  return useMemo(() => {
    const known = new Set((catalog.data?.items ?? []).map((c) => c.name.toLowerCase()));
    return {
      departments: uniq(
        (emps.data ?? []).map((e) => e.department),
        () => "отдел",
      ),
      vendors: uniq([
        ...(catalog.data?.items ?? []).map((c) => c.vendor),
        ...(unknown.data?.items ?? []).map((u) => u.publisher),
      ]),
      /** программы, которых ещё нет в каталоге: hint — издатель и сколько ПК; value — издатель (для автозаполнения) */
      newSoftware: (unknown.data?.items ?? [])
        .filter((u) => !known.has(u.example_raw_name.toLowerCase()))
        .map((u): Option => ({
          value: u.publisher ?? "",
          label: u.example_raw_name,
          hint: `${u.publisher ? `${u.publisher} · ` : ""}${u.devices} ПК`,
        })),
      catalogNames: (catalog.data?.items ?? []).map((c): Option => ({
        value: c.vendor ?? "",
        label: c.name,
        hint: c.vendor ?? undefined,
      })),
      contracts: uniq((purchases.data ?? []).map((p) => p.contract)),
      licenseNames: (types.data ?? []).map((t): Option => ({ value: t.kind, label: t.name, hint: t.kind })),
    };
  }, [emps.data, catalog.data, unknown.data, purchases.data, types.data]);
}
