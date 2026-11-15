//! Лог агента: stderr + файл %ProgramData%\sam-agent\agent.log на Windows (служба не имеет консоли).
//! Файл > 5 МБ переименовывается в agent.log.old. Время — UTC.
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Папка данных агента: состояние и лог. У службы рабочая папка System32, поэтому путь абсолютный.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into())).join("sam-agent")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(".")
    }
}

/// 1700000000 -> "2023-11-14 22:13:20" (UTC), без внешних зависимостей.
pub fn fmt_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn write(level: &str, msg: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("{} [{level}] {msg}\n", fmt_utc(now));
    eprint!("{line}");
    if cfg!(windows) {
        let dir = data_dir();
        let path = dir.join("agent.log");
        let _ = std::fs::create_dir_all(&dir);
        if std::fs::metadata(&path)
            .map(|m| m.len() > 5 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&path, dir.join("agent.log.old"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

pub fn info(msg: &str) {
    write("INFO", msg)
}
pub fn error(msg: &str) {
    write("ERROR", msg)
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_format() {
        assert_eq!(super::fmt_utc(0), "1970-01-01 00:00:00");
        assert_eq!(super::fmt_utc(1_700_000_000), "2023-11-14 22:13:20");
        assert_eq!(super::fmt_utc(1_709_210_096), "2024-02-29 12:34:56"); // високосный
    }
}
