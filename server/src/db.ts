import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";

export type DB = DatabaseSync;

/** Открывает БД и применяет schema.sql. `:memory:` для тестов. */
export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  // мини-миграции для уже существующих БД (CREATE TABLE IF NOT EXISTS не добавляет колонки)
  ensureColumn(db, "installation", "install_location", "TEXT");
  ensureColumn(db, "device", "agent_last_seen", "TEXT");
  ensureColumn(db, "app_user", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
  ensureDeviceId(db);
  migrateAgentCommand(db);
  // lower() в SQLite понимает только ASCII; для поиска по кириллице — ulower()
  db.function("ulower", { deterministic: true }, (v: unknown) => (v == null ? null : String(v).toLowerCase()));
  return db;
}

/**
 * Шаблон «содержит» для `LIKE ? ESCAPE '\'`: поиск буквальный — `%`, `_` и `\` в запросе пользователя ищутся как есть.
 * Пустая строка или null → null (фильтр выключен). Регистр приводится к нижнему (поиск — по ulower(...)).
 */
export function likeContains(term: string | null | undefined): string | null {
  if (!term) return null;
  return `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Типизированные запросы: строки SQLite приходят как Record<string, значение>, форму строки задаёт сам SELECT.
 * Это единственное место, где тип строки приводится к интерфейсу — в остальном коде без `as unknown as`.
 */
export function all<T>(db: DB, sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}
/** Одна строка запроса или undefined, если строк нет. */
export function one<T>(db: DB, sql: string, ...args: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...args) as unknown as T | undefined;
}

/** Выполнить функцию в транзакции (откат при исключении). Вложенные вызовы идут в транзакции внешнего. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn(); // вложенный вызов — уже внутри внешней транзакции
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * В старых БД agent_command создана с CHECK (type IN ('set_license')): SQLite не меняет CHECK → пересоздаём таблицу.
 */
function migrateAgentCommand(db: DB) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_command'").get() as
    { sql: string } | undefined;
  if (!row || row.sql.includes("'snapshot'")) return;
  const create = readFileSync(new URL("./schema.sql", import.meta.url), "utf8").match(
    /CREATE TABLE IF NOT EXISTS agent_command \([\s\S]*?\);/,
  )?.[0];
  if (!create) throw new Error("schema.sql: не найдено описание agent_command");
  tx(db, () => {
    db.exec("ALTER TABLE agent_command RENAME TO agent_command_old");
    db.exec(create);
    db.exec("INSERT INTO agent_command SELECT * FROM agent_command_old");
    db.exec("DROP TABLE agent_command_old");
    db.exec("CREATE INDEX IF NOT EXISTS ix_cmd_device ON agent_command(device_serial, status)");
  });
}

/** Числовой id устройства для адресов: колонка + заполнение старых строк + уникальный индекс + триггер для новых. */
function ensureDeviceId(db: DB) {
  ensureColumn(db, "device", "id", "INTEGER");
  const set = db.prepare(
    "UPDATE device SET id = (SELECT COALESCE(MAX(id), 0) + 1 FROM device) WHERE serial_number = ?",
  );
  for (const r of db.prepare("SELECT serial_number FROM device WHERE id IS NULL ORDER BY rowid").all() as {
    serial_number: string;
  }[])
    set.run(r.serial_number);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_device_id ON device(id);
    CREATE TRIGGER IF NOT EXISTS device_id AFTER INSERT ON device WHEN NEW.id IS NULL BEGIN
      UPDATE device SET id = (SELECT COALESCE(MAX(id), 0) + 1 FROM device) WHERE serial_number = NEW.serial_number;
    END;`);
}

function ensureColumn(db: DB, table: string, column: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
