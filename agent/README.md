# sam-agent — агент EasySAM для Windows (учёт ПО и лицензий)

Один файл `sam-agent.exe`. Работает как служба Windows: раз в 30 с сравнивает список установленных программ
с прошлым и отправляет на сервер только изменения (установили / удалили / обновили). Первый запуск и раз в час —
полный снимок (программы и лицензии). Если сервер недоступен, изменения не теряются: уйдут при следующей удачной попытке.

## Что собирает, откуда и что уходит на сервер

| Что | Откуда (код) | На сервер |
|---|---|---|
| Серийный номер ПК, имя, ОС | SMBIOS (`smbios.rs`), при «To be filled by O.E.M.» — `GUID-<MachineGuid>` | `serial_number`, `hostname`, `os` |
| Установленные программы | реестр `Uninstall`: HKLM (64/32 бит) и `HKEY_USERS` (`collect.rs`) | название, издатель, версия, дата установки, `InstallLocation` |
| Изменения | сравнение с прошлым состоянием (`diff.rs`) | события installed / removed / updated |
| Запущенные программы | список процессов вне `C:\Windows`, сведения из exe — VERSIONINFO (`process.rs`) | exe, путь, ProductName, CompanyName, версия, первый/последний раз |
| Лицензии Windows и Office | WMI `SoftwareLicensingProduct` (`licenses.rs`) | статус, канал, срок, **5 последних символов** ключа |
| КриптоПро CSP | MSI `ProductID` в реестре установщика, `cpconfig.exe` — если есть (`cryptopro.rs`) | статус, срок, 5 последних символов серийного номера |
| Kaspersky Endpoint Security | `avp.com LICENSE /CHECK` (KES 12.x) (`kaspersky.rs`) | тип, срок, 5 последних символов ID лицензии |
| nanoCAD, 1С, Dr.Web | файлы лицензий `.lic` / `.key` (`licfiles.rs`) | статус, срок, 5 последних символов номера |

Полный ключ лицензии с ПК не уходит никогда. С сервера агент принимает только задание `set_license` (КриптоПро) и `snapshot`.

Запущенные программы: раз в цикл список процессов (кроме системных из `C:\Windows`, Защитника и встроенных приложений) с полным путём и сведениями из exe (ProductName, CompanyName, версия); раз в `usage_interval` (по умолчанию 300 с) — сводка «что запускалось, первый/последний раз» на сервер. Плюс `InstallLocation` установленных программ — по нему сервер связывает процесс с программой.

Лицензии российского ПО (подробно и с источниками — `docs/LICENSES_RU.md`), отправляются со снимком, наружу только 5 последних символов ключа:
- **КриптоПро CSP** (`cryptopro.rs`): серийный номер из реестра установщика — `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData\S-1-5-18\Products\<код>\InstallProperties\ProductID` (на Windows консольного `cpconfig.exe` нет — только апплет `cpconfig.cpl`). Нет серийника → временная лицензия, срок = дата установки + 90 дней. Если `cpconfig.exe` всё же есть — разбор его вывода.
- **Kaspersky Endpoint Security** (`kaspersky.rs`): `avp.com LICENSE /CHECK` (есть с KES 12.x): тип, ID лицензии, дата окончания / дней, резервные ключи. KES 10/11 → `unknown` «смотреть в KSC».
- **nanoCAD, 1С, Dr.Web** (`licfiles.rs`): файлы лицензий (`.lic` / `.key`) в ProgramData и папке установки.

Задания сервера: агент каждый цикл спрашивает `GET /api/agent/commands`; выполняет **только** `set_license` для КриптоПро (`cpconfig -license -set`, без него — запись `ProductID`; затем проверка, что встал именно этот ключ), отчитывается и сразу шлёт новый снимок. Других команд агент не выполняет. Сырой вывод (ключи замаскированы) — в `print`: `cryptopro_raw`, `kaspersky_raw`.

Лицензии Windows и Office (WMI `SoftwareLicensingProduct`, для Office 2010 `OfficeSoftwareProtectionProduct`): статус активации, канал (Retail/OEM/Volume), **последние 5 символов** ключа и срок (конец льготного периода / KMS-активации / ознакомительной версии). Полный ключ не собирается. Отправляются со снимком (старт и раз в сутки) — WMI медленный. Если сервер не знает ПК (база пересоздана), агент сам отправит полный снимок.

Что читает: реестр `Uninstall` — HKLM (64- и 32-битные программы) и `HKEY_USERS` (программы, установленные
«только для меня», у вошедших пользователей). Серийный номер — из BIOS, при «To be filled by O.E.M.» — `GUID-<MachineGuid>`.

## Сборка

На Windows (нужен Rust): `cargo build --release` → `target\release\sam-agent.exe`
На Linux: `sudo pacman -S mingw-w64-gcc` (Arch) / `sudo apt install mingw-w64` (Ubuntu), затем из корня `make agent-windows`
→ `agent/target/x86_64-pc-windows-gnu/release/sam-agent.exe`.

## Установка на ПК (рабочий режим): `install-sam-agent.ps1`

1. На сервере выдать ключ регистрации: `make enroll-key TITLE="Бухгалтерия" USES=50` (или `POST /api/agent-enroll-keys`).
2. На ПК — PowerShell **от имени администратора**, в папке с `sam-agent.exe` и `install-sam-agent.ps1`:
   ```bat
   powershell -ExecutionPolicy Bypass -File .\install-sam-agent.ps1 -Server 192.168.249.1 -EnrollKey sek_XXXX
   ```
   Скрипт: проверит сервер → скопирует exe в `C:\Program Files\SAM` → запишет `Server`, `EnrollKey`, `Interval`, `UsageInterval` в `HKLM\SOFTWARE\SAM\Agent` → закроет этот раздел (только SYSTEM и Администраторы) → поставит службу → дождётся, пока агент зарегистрируется (в реестре появится `AgentToken`).
   Ключи: `-Interval 30`, `-UsageInterval 300`, `-ReEnroll` (получить новый токен), `-Uninstall` (удалить всё).
3. Много ПК сразу: `deploy-sam-agent.ps1 -Computers PC1,PC2 -Server … -EnrollKey …` (по сети: `C$` + WinRM) или `install-sam-agent.ps1` как стартовый скрипт GPO / задача SCCM.

Токен ПК: агент получает его сам по ключу регистрации и ходит с ним (`X-Agent-Token`); сервер принимает его только для этого серийника. Отозвали токен на сервере → агент сотрёт его и зарегистрируется заново по ключу из реестра.
**Скрипты .ps1 написаны без возможности запуска (на машине разработки нет PowerShell) — проверить на ВМ.**

## Запуск без установщика: двойной клик = фон

`sam-agent.exe` без параметров: служба уже есть → убедиться, что работает; есть права администратора → установить службу (невидима, автозапуск с Windows); иначе → скрытый фоновый процесс. Один агент на ПК (мьютекс `Global\sam-agent`). Ошибки сети, настроек и даже внутренние паники не роняют агента: лог и повтор. `sam-agent.exe stop` — остановить всё.

## Настройки: `sam-agent.json` рядом с exe

Можно JSON или **просто адрес одной строкой** (`192.168.249.1` → `http://192.168.249.1:8000`); имя файла также `sam-agent.json.txt` / `sam-agent.txt` (Windows прячет расширения).

```json
{ "server": "http://192.168.249.1:8000", "enroll_key": "sek_…", "interval": 60 }
```
Порядок: значения по умолчанию → реестр `HKLM\SOFTWARE\SAM\Agent` (установщик) → файл (рядом с exe, иначе `%ProgramData%\sam-agent\config.json`, или явный `--config PATH`) → аргументы командной строки. Ключи с `_` — комментарии. Готовый файл с новым ключом регистрации скачивается в интерфейсе: «Агенты» → «Установка агента». Готовая папка для ВМ: `make agent-dist` → `agent/dist/sam-agent/` (exe, настройки, `ТЕСТ.md` — пошаговый тест).

## Проверка на ПК (без установки)

```bat
sam-agent.exe print
sam-agent.exe run --once          (адрес и токен из sam-agent.json)
```
`print` показывает, что агент видит (серийник, ОС, программы), ничего не отправляя.
`run --once` отправляет один раз; без `--once` работает в консоли постоянно (Ctrl+C — выход).

## Установка службы (cmd «от имени администратора»)

```bat
mkdir "C:\Program Files\SAM"
copy sam-agent.exe "C:\Program Files\SAM\"
copy sam-agent.json "C:\Program Files\SAM\"
"C:\Program Files\SAM\sam-agent.exe" install
```
Служба `sam-agent` стартует сразу и при каждой загрузке Windows. Проверить: `sc query sam-agent`.
Лог: `C:\ProgramData\sam-agent\agent.log`, состояние: `C:\ProgramData\sam-agent\state.json`.
Удалить: `"C:\Program Files\SAM\sam-agent.exe" uninstall`.

Демо: поставить любую запрещённую программу (в демо-каталоге это WinRAR) → в течение 30 с на дашборде красный алерт.

## Параметры

| Параметр | По умолчанию | |
|---|---|---|
| `--config` | `sam-agent.json` рядом с exe | файл настроек (JSON) |
| `--server` | — | адрес API, обязательно (в файле или аргументом) |
| `--enroll-key` | — | ключ регистрации: по нему агент получает собственный токен ПК (рабочий режим) |
| `--token` | `dev-token` | общий `INGEST_TOKEN` (только разработка: сервер принимает его, лишь если `INGEST_TOKEN` задан) |
| `--usage-interval` | `300` | секунд между сводками запущенных программ (≥ 30) |
| `--interval` | `30` | секунд между проверками (≥ 5) |
| `--once` | — | один цикл и выход |
| `--state` | `%ProgramData%\sam-agent\state.json` | файл последнего отправленного состояния |
| `--fake FILE` | — | вместо реестра взять список из JSON (отладка на Linux): `{"serial_number","hostname","os","items":[{"name","publisher","version"}]}` |

## Ограничения

- Нужна Windows 10/11 или Windows 7/8.1 с обновлением UCRT (KB2999226): агент использует системную C-библиотеку `api-ms-win-crt-*`. Других DLL не требуется — файл копируется как есть.
- Программы пользователей, которые сейчас не вошли в систему, не видны (их ветка реестра не загружена).
- Токен хранится в параметрах службы (`sc qc sam-agent`) — виден администраторам ПК.
- Проверено: логика (снимок, события, повтор после обрыва, ошибки токена) — против живого сервера на Linux в режиме `--fake`; на ВМ с Windows 10 — снимок, события, серийник, лицензия Windows, процессы. Не проверены на Windows: КриптоПро из `ProductID`, `avp.com LICENSE /CHECK`, служба после перезагрузки (см. `docs/PROGRESS.md`).
- Код: `main.rs` — команды, цикл, задания; `config.rs` — настройки (файл, реестр, аргументы) и их тесты; `gather.rs` — сбор с ПК или из `--fake`. Каждый `unsafe` — с комментарием `// SAFETY:`. Проверка: `make agent-test`, `make clippy` (Linux и Windows, без предупреждений).
