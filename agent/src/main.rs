//! sam-agent — постоянный агент учёта ПО (Windows).
//!
//! Цикл: собрать ПО → сравнить с последним УСПЕШНО отправленным состоянием (state.json) → отправить события.
//! Состояние продвигается только после успешной отправки, поэтому при недоступном сервере ничего не теряется
//! (diff пересчитается в следующий раз) — отдельная очередь не нужна.
//! Первый запуск и раз в час: полный снимок с лицензиями (сверка на случай пропущенных событий).
//!
//! Команды:
//!   sam-agent run --server URL [--token T] [--interval 30] [--once] [--state PATH] [--fake FILE]
//!   sam-agent print [--fake FILE]                 — показать, что агент видит (без отправки)
//!   sam-agent install --server URL --token T [--interval N]   — служба Windows (от администратора)
//!   sam-agent uninstall
//! Без команды = run (совместимость). Протокол: docs/API.md §6.
#[cfg(windows)]
mod background;
mod client;
mod collect;
mod config;
mod cryptopro;
mod diff;
#[cfg(windows)]
mod exec;
mod gather;
mod kaspersky;
mod licenses;
mod licfiles;
mod log;
mod model;
mod process;
mod registry;
#[cfg(windows)]
mod service;
mod smbios;

use client::Client;
use config::{parse_config, Config, USAGE};
use gather::{gather, gather_licenses, gather_processes, read_fake, FAKE_CP_KEY};
use model::Item;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Полный снимок (программы + лицензии) раз в час: лицензии меняются и без установки программ (ввели ключ вручную, истёк триал).
const SNAPSHOT_EVERY: u64 = 3600;
#[derive(Default, Serialize, Deserialize)]
struct State {
    items: Vec<Item>,
    last_snapshot: u64,
    has_state: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Выполнить задания сервера. Белый список: только set_license для известных продуктов.
fn commands_tick(cfg: &Config, client: &Client, state: &mut State) -> Result<(), String> {
    let serial = match &cfg.fake {
        Some(path) => read_fake(path)?.device.serial_number,
        None => collect::device()?.serial_number,
    };
    let mut changed = false;
    for c in client.commands(&serial)? {
        let key = c.key.clone().unwrap_or_default();
        let res = match (c.kind.as_str(), c.product.as_str()) {
            // «Запросить снимок» из интерфейса: полный снимок уйдёт сразу после цикла заданий
            ("snapshot", _) => Ok("полный снимок будет отправлен сейчас".to_string()),
            ("set_license", cryptopro::PRODUCT) if cfg.fake.is_some() => {
                if cryptopro::valid_key(&key) {
                    *FAKE_CP_KEY.lock().map_err(|e| e.to_string())? = Some(key.trim().to_ascii_uppercase());
                    Ok("fake: ключ применён".to_string())
                } else {
                    Err("неверный формат ключа".to_string())
                }
            }
            ("set_license", cryptopro::PRODUCT) => cryptopro::apply(&key),
            (k, p) => Err(format!("команда {k}/{p} не поддерживается этой версией агента")),
        };
        let tail: String = key
            .chars()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        match (&res, c.kind.as_str()) {
            (Ok(_), "snapshot") => log::info("сервер запросил полный снимок"),
            (Ok(_), _) => log::info(&format!("ключ {} …{tail} установлен", c.product)),
            (Err(e), _) => log::error(&format!("задание {} {} не выполнено: {e}", c.kind, c.product)),
        }
        changed |= res.is_ok();
        let (ok, out) = match res {
            Ok(o) => (true, o),
            Err(e) => (false, e),
        };
        client.command_result(c.id, &serial, ok, &out)?;
    }
    if changed {
        state.has_state = false; // сразу отправить новый снимок с обновлённой лицензией
    }
    Ok(())
}

fn tick(cfg: &Config, client: &Client, state: &mut State) -> Result<(), String> {
    let (dev, items) = gather(&cfg.fake)?;
    if !state.has_state || now().saturating_sub(state.last_snapshot) >= SNAPSHOT_EVERY {
        let lic = gather_licenses(&cfg.fake, &items);
        client.snapshot(&dev, &items, &lic)?;
        log::info(&format!(
            "снимок отправлен: {} ({}), {} программ, {} лицензий",
            dev.serial_number,
            dev.hostname.as_deref().unwrap_or("-"),
            items.len(),
            lic.len()
        ));
        *state = State {
            items,
            last_snapshot: now(),
            has_state: true,
        };
    } else {
        let events = diff::diff(&state.items, &items);
        if events.is_empty() {
            return Ok(()); // нечего сохранять
        }
        if let Err(e) = client.events(&dev, &events) {
            if e == client::NEED_SNAPSHOT {
                log::info("сервер не знает этот ПК (база пересоздана?) — отправляю полный снимок");
                state.has_state = false;
                return tick(cfg, client, state);
            }
            return Err(e);
        }
        log::info(&format!("события отправлены: {}", events.len()));
        // поставили/обновили/удалили продукт, лицензию которого мы читаем, — сразу полный снимок с лицензиями
        let touches_license = events.iter().any(|e| {
            cryptopro::installed_version(std::slice::from_ref(&Item {
                name: e.name.clone(),
                publisher: None,
                version: None,
                install_date: None,
                install_location: None,
            }))
            .is_some()
        });
        state.items = items;
        if touches_license {
            log::info("изменился КриптоПро CSP — перечитываю лицензии");
            state.has_state = false;
            return tick(cfg, client, state);
        }
    }
    if let Some(dir) = cfg.state.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&cfg.state, serde_json::to_string(state).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{}: {e}", cfg.state.display()))
}

/// Наблюдение за процессами + отправка сводки раз в usage_interval (и сразу в режиме --once).
fn usage_tick(cfg: &Config, client: &Client, tracker: &mut process::Tracker, state: &mut State) -> Result<(), String> {
    let t = now();
    tracker.observe(
        gather_processes(&cfg.fake),
        t,
        &process::system_root(),
        &process::version_info,
    );
    if tracker.last_sent == 0 {
        tracker.last_sent = t; // первый интервал отсчитываем от старта
    }
    if tracker.is_empty() || (!cfg.once && !tracker.due(t, cfg.usage_interval)) {
        return Ok(());
    }
    let dev = match &cfg.fake {
        Some(path) => read_fake(path)?.device,
        None => collect::device()?,
    };
    let report = tracker.report();
    match client.usage(&dev, &report) {
        Ok(()) => {
            log::info(&format!("процессы отправлены: {}", report.len()));
            tracker.clear(t);
            Ok(())
        }
        Err(e) if e == client::NEED_SNAPSHOT => {
            state.has_state = false; // в следующем цикле уйдёт полный снимок, сводка процессов сохранится
            Err(e)
        }
        Err(e) => Err(e),
    }
}

/// Нет собственного токена, но есть ключ регистрации → зарегистрироваться и сохранить токен (реестр / файл).
fn ensure_enrolled(cfg: &Config, client: &Client) -> Result<(), String> {
    let Some(key) = cfg.enroll_key.as_deref() else {
        return Ok(());
    };
    if client.has_device_token() {
        return Ok(());
    }
    let dev = match &cfg.fake {
        Some(path) => read_fake(path)?.device,
        None => collect::device()?,
    };
    let token = client.enroll(key, &dev)?;
    let saved = registry::save_token(&token, &cfg.state)?;
    client.set_device_token(Some(token));
    log::info(&format!(
        "ПК {} зарегистрирован, токен сохранён: {saved}",
        dev.serial_number
    ));
    Ok(())
}

/// Сервер сказал «токен отозван» — забыть его; в следующем цикле агент зарегистрируется заново (если есть ключ).
fn forget_token_if_revoked(cfg: &Config, client: &Client, err: &str) {
    if err.contains(client::NEED_ENROLL) {
        client.set_device_token(None);
        registry::forget_token(&cfg.state);
        log::info("токен ПК отозван сервером — повторная регистрация в следующем цикле");
    }
}

/// Выполнить шаг цикла так, чтобы даже паника внутри не уронила агента.
fn guarded(name: &str, f: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(p) => {
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            Err(format!("внутренняя ошибка ({name}): {msg}"))
        }
    }
}

/// Фоновый режим (служба, скрытый процесс, `run`): не выходит из-за ошибок настроек — пишет в лог и ждёт,
/// пока файл настроек исправят. Один экземпляр на ПК.
pub fn run_forever(args: &[String], wait: &dyn Fn(Duration) -> bool) {
    if !single_instance() {
        log::info("агент уже работает на этом ПК (служба или фоновый процесс) — второй экземпляр не запускаю");
        return;
    }
    loop {
        match parse_config(args) {
            Ok(cfg) => {
                log::info(&format!(
                    "сервер {}, интервал {} с, процессы раз в {} с, настройки: {}, токен: {}",
                    cfg.server,
                    cfg.interval,
                    cfg.usage_interval,
                    cfg.source,
                    if cfg.agent_token.is_some() {
                        "собственный токен ПК"
                    } else if cfg.enroll_key.is_some() {
                        "будет получен по ключу регистрации"
                    } else {
                        "общий (разработка)"
                    }
                ));
                return run_loop(&cfg, wait);
            }
            Err(e) => {
                log::error(&format!("{e}\nжду исправления настроек, повтор через 30 с"));
                if wait(Duration::from_secs(30)) {
                    return;
                }
            }
        }
    }
}

/// Именованный мьютекс Global\sam-agent: служба и фоновый процесс не дублируют друг друга.
#[cfg(windows)]
fn single_instance() -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name: Vec<u16> = "Global\\sam-agent".encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: имя — корректная UTF-16 строка с нулём; дескриптор намеренно не закрываем до выхода процесса.
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        let err = GetLastError();
        // уже есть (наш же), либо создан службой SYSTEM и пользователю недоступен — значит, агент работает
        let running = err == ERROR_ALREADY_EXISTS || (h.is_null() && err == ERROR_ACCESS_DENIED);
        !running // прочие сбои создания мьютекса работе не мешают
    }
}
#[cfg(not(windows))]
fn single_instance() -> bool {
    true
}

/// Основной цикл. `wait(d)` спит до d и возвращает true, если пора остановиться (служба: сигнал Stop).
pub fn run_loop(cfg: &Config, wait: &dyn Fn(Duration) -> bool) {
    let client = Client::new(&cfg.server, &cfg.token);
    client.set_device_token(cfg.agent_token.clone());
    let mut state: State = std::fs::read_to_string(&cfg.state)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut tracker = process::Tracker::default();
    loop {
        let mut failed = false;
        if let Err(e) = guarded("регистрация", || ensure_enrolled(cfg, &client)) {
            log::error(&e);
        }
        if let Err(e) = guarded("снимок", || tick(cfg, &client, &mut state)) {
            log::error(&format!("{e} (повтор через {} с)", cfg.interval));
            forget_token_if_revoked(cfg, &client, &e);
            failed = true;
        }
        if let Err(e) = guarded("процессы", || {
            usage_tick(cfg, &client, &mut tracker, &mut state)
        }) {
            log::error(&format!("процессы: {e}"));
            forget_token_if_revoked(cfg, &client, &e);
            failed = true;
        }
        if let Err(e) = guarded("команды", || commands_tick(cfg, &client, &mut state)) {
            log::error(&format!("команды: {e}"));
            forget_token_if_revoked(cfg, &client, &e);
            failed = true;
        } else if !state.has_state {
            // ключ только что установлен — новый снимок с лицензией сразу, не ждём следующего цикла
            if let Err(e) = guarded("снимок", || tick(cfg, &client, &mut state)) {
                log::error(&e);
            }
        }
        if cfg.once {
            if failed {
                std::process::exit(1);
            }
            break;
        }
        if wait(Duration::from_secs(cfg.interval)) {
            break;
        }
    }
}

fn exit_err(e: String) -> ! {
    log::error(&e);
    std::process::exit(2);
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, rest): (&str, &[String]) = match argv.first().map(String::as_str) {
        None => ("start", &argv[..]), // двойной клик
        Some(
            c @ ("run" | "print" | "install" | "uninstall" | "service" | "start" | "stop" | "help" | "--help" | "-h"),
        ) => (c, &argv[1..]),
        _ => ("run", &argv[..]),
    };
    match cmd {
        "run" if rest.iter().any(|a| a == "--once") => {
            // разовый запуск для проверки: ошибки настроек — сразу и с кодом выхода
            let cfg = parse_config(rest).unwrap_or_else(|e| exit_err(e));
            run_loop(&cfg, &|_| true);
        }
        "run" => run_forever(rest, &|d| {
            std::thread::sleep(d);
            false
        }),
        #[cfg(windows)]
        "start" => background::start(rest),
        #[cfg(windows)]
        "stop" => background::stop(),
        "print" => {
            let fake = rest
                .iter()
                .position(|a| a == "--fake")
                .and_then(|i| rest.get(i + 1))
                .cloned();
            let (dev, items) = gather(&fake).unwrap_or_else(|e| exit_err(e));
            let lic = gather_licenses(&fake, &items);
            let raw = |r: Option<Result<String, String>>| {
                if fake.is_none() {
                    r.map(|r| r.unwrap_or_else(|e| format!("ошибка: {e}")))
                } else {
                    None
                }
            };
            let cp_raw = raw(cryptopro::raw_view(&items));
            let kes_raw = raw(kaspersky::raw_view(&items));
            let mut tracker = process::Tracker::default();
            tracker.observe(
                gather_processes(&fake),
                now(),
                &process::system_root(),
                &process::version_info,
            );
            let procs = tracker.report();
            let out = serde_json::json!({ "device": dev, "licenses": lic, "cryptopro_raw": cp_raw, "kaspersky_raw": kes_raw, "processes": procs, "count": items.len(), "items": items });
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        }
        #[cfg(windows)]
        "install" => service::install(rest).unwrap_or_else(|e| exit_err(e)),
        #[cfg(windows)]
        "uninstall" => service::uninstall().unwrap_or_else(|e| exit_err(e)),
        #[cfg(windows)]
        "service" => service::run_as_service().unwrap_or_else(|e| exit_err(e)),
        #[cfg(not(windows))]
        "install" | "uninstall" | "service" | "start" | "stop" => {
            exit_err("служба и фоновый режим — только на Windows; здесь используйте run".into())
        }
        _ => println!("{USAGE}"),
    }
}
