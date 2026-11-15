-- Схема БД (SQLite). Описание и инварианты: docs/DATA_MODEL.md. Применяется при старте (IF NOT EXISTS).
-- Сменили схему → `make reset-db` (миграций нет, хакатон).

CREATE TABLE IF NOT EXISTS employee (
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, department TEXT, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS device (
  serial_number TEXT PRIMARY KEY,           -- строка! бывают «VMware-42 37 a3…»
  id INTEGER,                                  -- короткий номер для адресов (/agents/12); выдаёт триггер device_id (db.ts)
  hostname TEXT, os TEXT,
  employee_id INTEGER REFERENCES employee(id),
  last_seen TEXT,                              -- любая загрузка (CSV, seed, агент)
  agent_last_seen TEXT);                       -- последний контакт АГЕНТА → статус «в сети»; NULL = агента нет

CREATE TABLE IF NOT EXISTS license_type (     -- справочник соглашений (GPL, MIT, EULA…)
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'open_source'
    CHECK (kind IN ('open_source','freeware','shareware','trial','commercial')),
  commercial_use INTEGER, copyleft INTEGER, notes TEXT,
  eula_analysis TEXT);                         -- JSON от ИИ

CREATE TABLE IF NOT EXISTS software_catalog ( -- каталог разрешённого ПО
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, vendor TEXT, purpose TEXT,
  registry_section TEXT, registry_class TEXT,  -- классификатор реестра РФ
  internal_status TEXT NOT NULL DEFAULT 'current'
    CHECK (internal_status IN ('current','outdated','forbidden')),
  min_version TEXT,                            -- ниже = «устаревший»
  license_type_id INTEGER REFERENCES license_type(id),
  license_kind TEXT NOT NULL DEFAULT 'open_source'
    CHECK (license_kind IN ('open_source','freeware','shareware','trial','commercial')),
  in_ru_registry INTEGER,
  list_price REAL);                            -- ₽ за место, если закупок нет (оценка штрафа)

CREATE TABLE IF NOT EXISTS license_purchase ( -- «куплено» = сумма seats по действующим
  id INTEGER PRIMARY KEY,
  catalog_id INTEGER NOT NULL REFERENCES software_catalog(id),
  seats INTEGER NOT NULL, unit_price REAL NOT NULL DEFAULT 0,
  valid_until TEXT, contract TEXT);

CREATE TABLE IF NOT EXISTS alias (            -- выученное «грязное имя → каталог»
  id INTEGER PRIMARY KEY, norm_name TEXT NOT NULL UNIQUE,
  catalog_id INTEGER NOT NULL REFERENCES software_catalog(id),
  method TEXT NOT NULL DEFAULT 'manual', confidence REAL NOT NULL DEFAULT 1,
  confirmed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS ingest_batch (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rows_total INTEGER NOT NULL DEFAULT 0, rows_noise INTEGER NOT NULL DEFAULT 0,
  rows_matched INTEGER NOT NULL DEFAULT 0, rows_unknown INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS installation (     -- текущее состояние: что стоит на устройстве
  id INTEGER PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES device(serial_number),
  batch_id INTEGER REFERENCES ingest_batch(id),
  raw_name TEXT NOT NULL, raw_publisher TEXT, raw_version TEXT,
  install_location TEXT,                       -- папка программы (реестр InstallLocation) → связь с процессами
  norm_name TEXT NOT NULL DEFAULT '',
  is_noise INTEGER NOT NULL DEFAULT 0,
  catalog_id INTEGER REFERENCES software_catalog(id),
  match_method TEXT, match_score REAL,
  last_used TEXT, collected_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_inst_device ON installation(device_serial);
CREATE INDEX IF NOT EXISTS ix_inst_catalog ON installation(catalog_id);

CREATE TABLE IF NOT EXISTS install_event (    -- история: установили / удалили / обновили
  id INTEGER PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES device(serial_number),
  type TEXT NOT NULL CHECK (type IN ('installed','removed','updated')),
  raw_name TEXT NOT NULL, raw_publisher TEXT,
  old_version TEXT, new_version TEXT,
  catalog_id INTEGER REFERENCES software_catalog(id),
  at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_event_device ON install_event(device_serial, at);

CREATE TABLE IF NOT EXISTS ignored_name (     -- имена, помеченные человеком как «не учитывать» (компоненты, плагины)
  norm_name TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS device_license (   -- лицензии Windows/Office с ПК (агент, SPP/WMI); снимок заменяет строки ПК
  id INTEGER PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES device(serial_number),
  application TEXT NOT NULL,                   -- windows | office | other
  product TEXT NOT NULL, description TEXT,
  channel TEXT,                                -- Retail | OEM… | Volume:MAK | Volume:GVLK | …
  partial_key TEXT,                            -- ТОЛЬКО последние 5 символов; полный ключ не храним
  status TEXT NOT NULL,                        -- licensed | grace | notification | unlicensed | unknown
  status_code INTEGER,
  expires_at TEXT,                             -- UTC, конец льготного периода / ознакомительной версии
  collected_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_lic_device ON device_license(device_serial);
CREATE INDEX IF NOT EXISTS ix_lic_key ON device_license(partial_key);

CREATE TABLE IF NOT EXISTS process_usage (    -- запуски программ на ПК (агент: процессы вне C:\Windows), агрегат по (ПК, путь exe)
  id INTEGER PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES device(serial_number),
  path_key TEXT NOT NULL,                      -- lower(путь), иначе lower(exe): ключ агрегации
  exe_name TEXT NOT NULL, exe_path TEXT,
  product_name TEXT, company TEXT, file_version TEXT,   -- из VERSIONINFO самого exe
  catalog_id INTEGER REFERENCES software_catalog(id),
  installation_name TEXT,                      -- с какой установленной программой связан (по пути)
  match_method TEXT,                           -- path | exe | product | fuzzy | NULL
  portable INTEGER NOT NULL DEFAULT 0,         -- запущено, но не установлено на этом ПК (и не из Program Files)
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_serial, path_key));
CREATE INDEX IF NOT EXISTS ix_proc_catalog ON process_usage(catalog_id);

CREATE TABLE IF NOT EXISTS license_pool (     -- хранилище купленных ключей (для раздачи на ПК). Полный ключ — СЕКРЕТ: наружу только маска
  id INTEGER PRIMARY KEY,
  product TEXT NOT NULL,                       -- код поставщика лицензии на агенте: cryptopro_csp | …
  title TEXT NOT NULL,                         -- «КриптоПро CSP 5.0, клиентская, бессрочная»
  license_key TEXT NOT NULL,
  key_tail TEXT NOT NULL,                      -- последние 5 символов (сопоставление с partial_key от агентов)
  seats INTEGER NOT NULL DEFAULT 1,            -- на сколько ПК можно установить
  valid_until TEXT,                            -- NULL = бессрочная
  license_type TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product, license_key));

CREATE TABLE IF NOT EXISTS agent_command (    -- команды агентам. Только типы из белого списка (set_license)
  id INTEGER PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES device(serial_number),
  type TEXT NOT NULL CHECK (type IN ('set_license','snapshot')),  -- миграция старых БД: db.ts migrateAgentCommand
  product TEXT NOT NULL, pool_id INTEGER REFERENCES license_pool(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','failed','cancelled')),
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_cmd_device ON agent_command(device_serial, status);

CREATE TABLE IF NOT EXISTS enroll_key (       -- ключ регистрации агентов (кладёт установщик). Храним ТОЛЬКО хеш
  id INTEGER PRIMARY KEY, title TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE, key_tail TEXT NOT NULL,   -- sha256 и последние 4 символа (для списка)
  max_uses INTEGER,                            -- NULL = без ограничения
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,                             -- YYYY-MM-DD включительно; NULL = бессрочно
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS agent_token (      -- токен конкретного ПК (выдаётся при регистрации). Храним ТОЛЬКО хеш
  id INTEGER PRIMARY KEY,
  device_serial TEXT NOT NULL REFERENCES device(serial_number),
  token_hash TEXT NOT NULL UNIQUE,
  enroll_key_id INTEGER REFERENCES enroll_key(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_token_device ON agent_token(device_serial);

CREATE TABLE IF NOT EXISTS app_user (         -- пользователи интерфейса. Пароль — только scrypt-хеш
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  password_hash TEXT NOT NULL,                 -- scrypt$<соль base64>$<хеш base64>
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 1 = пароль выдан (первый admin, создан/сброшен администратором): сменить при входе
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT);

CREATE TABLE IF NOT EXISTS user_session (     -- сессии входа (cookie sam_session). Храним ТОЛЬКО sha256 токена
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT);
CREATE INDEX IF NOT EXISTS ix_session_user ON user_session(user_id);
