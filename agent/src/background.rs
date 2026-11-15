//! Двойной клик по exe = «запустить и забыть»:
//!   1) служба уже установлена → убеждаемся, что работает;
//!   2) есть права администратора → ставим службу (невидима, стартует с Windows);
//!   3) иначе → скрытый фоновый процесс `run` (без окна; до выхода из системы).
//!
//! `stop` — остановить службу и фоновые процессы. Окно двойного клика не закрывается сразу, чтобы успеть прочитать.
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Окно открыто только ради нас (двойной клик) — подождать, чтобы человек успел прочитать.
fn pause_if_own_console() {
    use windows_sys::Win32::System::Console::GetConsoleProcessList;
    let mut ids = [0u32; 4];
    // SAFETY: буфер на 4 элемента, размер передан корректно.
    let n = unsafe { GetConsoleProcessList(ids.as_mut_ptr(), ids.len() as u32) };
    if n <= 1 {
        println!("\nОкно закроется через 15 секунд.");
        std::thread::sleep(std::time::Duration::from_secs(15));
    }
}

pub fn start(rest: &[String]) {
    let log_path = crate::log::data_dir().join("agent.log");
    match crate::parse_config(rest) {
        Err(e) => {
            println!("Агент НЕ запущен: {e}");
            pause_if_own_console();
            return;
        }
        Ok(cfg) => println!("Сервер: {}", cfg.server),
    }
    if let Ok(msg) = crate::service::ensure_running() {
        println!("Готово: {msg}. Лог: {}", log_path.display());
    } else if crate::service::install(rest).is_ok() {
        println!(
            "Готово: агент установлен как служба Windows «sam-agent» — работает в фоне и стартует вместе с Windows."
        );
        println!("Лог: {}", log_path.display());
    } else {
        let exe = std::env::current_exe().unwrap_or_else(|_| "sam-agent.exe".into());
        let mut args = vec!["run".to_string()];
        args.extend(rest.iter().cloned());
        match Command::new(&exe)
            .args(&args)
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                println!("Готово: агент работает в фоне (PID {}).", child.id());
                println!("Без прав администратора — до выхода из системы. Для автозапуска с Windows: правый клик по exe → «Запуск от имени администратора».");
                println!("Лог: {}   Остановить: sam-agent.exe stop", log_path.display());
            }
            Err(e) => println!("Не удалось запустить фоновый процесс: {e}"),
        }
    }
    pause_if_own_console();
}

pub fn stop() {
    match crate::service::stop() {
        Ok(()) => println!("служба sam-agent остановлена"),
        Err(_) => println!("служба sam-agent не запущена или нет прав"),
    }
    // фоновые процессы sam-agent.exe, кроме себя
    let me = std::process::id();
    let out = Command::new("taskkill")
        .args(["/F", "/IM", "sam-agent.exe", "/FI", &format!("PID ne {me}")])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) if o.status.success() => println!("фоновые процессы агента остановлены"),
        _ => println!("фоновых процессов агента нет"),
    }
}
