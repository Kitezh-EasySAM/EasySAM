export type InternalStatus = "current" | "outdated" | "forbidden";
/** Соответствие нужной версии каталога: ok — совпадает, older — старее (устарело), newer — обновилось сверх одобренной. */
export type VersionMatch = "ok" | "older" | "newer";
export type LicenseKind = "open_source" | "freeware" | "shareware" | "trial" | "commercial";
export type Severity = "red" | "yellow" | "green";
export type ComplianceStatus = "forbidden" | "over" | "outdated" | "idle" | "ok";

export interface ComplianceRow {
  catalog_id: number;
  name: string;
  license_kind: LicenseKind;
  seats: number;
  installed: number;
  deficit: number;
  idle: number;
  penalty: number;
  waste: number;
  zombie: number;
  reclaimable: number;
  running: number;
  status: ComplianceStatus;
  severity: Severity;
}
export interface Compliance {
  summary: { red: number; yellow: number; green: number; products: number } & Record<string, number>;
  rows: ComplianceRow[];
}
export interface EventRow {
  id: number;
  device_serial: string;
  type: "installed" | "removed" | "updated";
  raw_name: string;
  raw_publisher: string | null;
  old_version: string | null;
  new_version: string | null;
  catalog_id: number | null;
  catalog_name: string | null;
  internal_status: InternalStatus | null;
  at: string;
  hostname?: string | null;
}
export type AgentStatus = "online" | "offline" | "lost" | "no_agent";
export interface Device {
  id: number;
  serial_number: string;
  hostname: string;
  os: string | null;
  last_seen: string | null;
  employee: string | null;
  employee_id: number | null;
  department: string | null;
  agent_last_seen: string | null;
  agent_status: AgentStatus;
  software_count: number;
  forbidden_count: number;
  unknown_count: number;
}
export interface Software {
  id: number;
  raw_name: string;
  raw_publisher: string | null;
  raw_version: string | null;
  is_noise: number;
  match_method: string | null;
  catalog_id: number | null;
  last_used: string | null;
  catalog_name: string | null;
  internal_status: InternalStatus | null;
  license_kind: LicenseKind | null;
  min_version: string | null;
  version_match: VersionMatch | null;
}
/** Лицензия с ПК (Windows/Office — WMI SPP, КриптоПро — cpconfig); risks см. docs/API.md §10. */
export interface PcLicense {
  id: number;
  application: string;
  product: string;
  description: string | null;
  channel: string | null;
  partial_key: string | null;
  status: string;
  status_code: number;
  expires_at: string | null;
  collected_at: string | null;
  risks: string[];
  severity: Severity;
}
/** Запущенная программа (снимок процессов агента); match_method см. docs/API.md §11. */
export interface ProcessRow {
  id: number;
  exe_name: string;
  exe_path: string | null;
  product_name: string | null;
  company: string | null;
  file_version: string | null;
  catalog_id: number | null;
  catalog_name: string | null;
  internal_status: InternalStatus | null;
  license_kind: LicenseKind | null;
  installation_name: string | null;
  match_method: string | null;
  portable: boolean;
  first_seen: string | null;
  last_seen: string | null;
  samples: number;
}
export interface DeviceDetail {
  device: {
    id: number;
    serial_number: string;
    hostname: string;
    os: string | null;
    employee_id: number | null;
    last_seen: string | null;
    agent_last_seen: string | null;
    agent_status: AgentStatus;
    employee: string | null;
    department: string | null;
  };
  software: Software[];
  events: EventRow[];
  licenses: PcLicense[];
  processes: ProcessRow[];
}
export interface Employee {
  id: number;
  full_name: string;
  department: string | null;
  active: boolean;
  devices: string[];
  device_refs?: { id: number; serial_number: string; hostname: string | null }[];
}
export interface CatalogItem {
  id: number;
  name: string;
  vendor: string | null;
  purpose: string | null;
  registry_section: string | null;
  registry_class: string | null;
  internal_status: InternalStatus;
  min_version: string | null;
  license_kind: LicenseKind;
  license_type_name: string | null;
  in_ru_registry: boolean | null;
  list_price: number | null;
  installed: number;
  seats: number;
}
export interface CatalogDevice {
  device_serial: string;
  device_id: number;
  hostname: string;
  employee: string | null;
  department: string | null;
  employee_active: boolean;
  raw_name: string;
  raw_version: string | null;
  last_used: string | null;
  version_match: VersionMatch | null;
}
export interface Purchase {
  id: number;
  catalog_id: number;
  catalog_name: string;
  seats: number;
  unit_price: number;
  valid_until: string | null;
  contract: string | null;
  active: boolean;
  status: "perpetual" | "active" | "expiring" | "expired";
  days_left: number | null;
  total_cost: number;
  installed: number;
  license_kind: LicenseKind;
  /** установки этой позиции, «приходящиеся» на договор (сервер раскладывает по договорам) */
  used: number;
}
export interface PurchasesSummary {
  total: { purchases: number; seats: number; cost: number };
  active_cost: number;
  seats_active: number;
  seats_used: number;
  expiring_days: number;
  renewal_cost: number;
  by_status: Record<string, { purchases: number; seats: number; cost: number }>;
}
export interface LicenseType {
  id: number;
  name: string;
  kind: LicenseKind;
  commercial_use: boolean | null;
  copyleft: boolean | null;
  software_count: number;
}
export interface UnmatchedItem {
  norm_name: string;
  example_raw_name: string;
  publisher: string | null;
  devices: number;
  installations: number;
  suggestions: { catalog_id: number; name: string; score: number; method: string }[];
}
export interface Unmatched {
  total: number;
  total_installations: number;
  total_devices: number;
  items: UnmatchedItem[];
}
export interface StreamAlert {
  level: "red" | "yellow";
  reason: string;
  text: string;
}

/** Колокольчик: GET /api/notifications (docs/API.md §16) */
export interface Notice {
  id: string;
  level: "red" | "yellow" | "info";
  category: string;
  title: string;
  text: string;
  link: string | null;
}
export interface Notifications {
  counts: { red: number; yellow: number; info: number; total: number };
  items: Notice[];
}

/** Перенос лицензий: GET /api/licenses/reallocation (§15) */
export interface Seat {
  device_serial: string;
  device_id: number;
  hostname: string | null;
  employee: string | null;
  department: string | null;
  last_used: string | null;
  reason?: string;
}
export interface ReallocationItem {
  catalog_id: number;
  name: string;
  seats: number;
  installed: number;
  deficit: number;
  idle: number;
  unit_price: number;
  donors: Seat[];
  moves: { from: Seat; to: Seat }[];
  covered: number;
  remaining_deficit: number;
  savings: number;
  text: string;
}
export interface Reallocation {
  stale_days: number;
  total_savings: number;
  total_covered: number;
  items: ReallocationItem[];
}

/** ИИ-ассистент: POST /api/ai/chat (§14) */
export interface ChatAnswer {
  answer: string;
  intent: string;
  source: "rules" | "llm" | "none";
  table?: { columns: string[]; rows: (string | number | null)[][] };
  sql?: string;
  links?: { label: string; href: string }[];
  suggestions?: string[];
  eula?: EulaAnalysis;
}

/** Проверка лицензии: POST /api/ai/eula (§19) */
export type CommercialUse = "allowed" | "restricted" | "forbidden" | "unknown";
export interface EulaAnalysis {
  input: string;
  input_kind: "url" | "name" | "text";
  name: string | null;
  vendor: string | null;
  version: string | null;
  license_name: string | null;
  license_kind: LicenseKind | null;
  commercial_use: CommercialUse;
  copyleft: boolean | null;
  subscription: boolean | null;
  seat_limit: string | null;
  audit_rights: boolean | null;
  summary: string;
  risks: { point: string; quote: string | null }[];
  verdict: "approve" | "review" | "reject";
  verdict_text: string;
  suggested_status: "current" | "forbidden";
  source: "llm" | "rules";
  sources: string[];
  existing: { id: number; name: string; internal_status: InternalStatus } | null;
  text_chars: number;
}

/** Импорт из Excel: POST /api/import/:kind (§17) */
export type ImportKind = "employees" | "catalog" | "purchases";
export interface ImportResult {
  kind: ImportKind;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
  dry_run: boolean;
}

export interface EventFull extends EventRow {
  employee?: string | null;
  device_id?: number;
}

/** Пользователь интерфейса (§18) */
export interface AppUser {
  id: number;
  login: string;
  name: string | null;
  role: "admin" | "viewer";
  active: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}
