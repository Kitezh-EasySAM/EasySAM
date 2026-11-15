//! Настройки агента: файл sam-agent.json (рядом с exe или --config), параметры командной строки и реестр
//! (HKLM\\SOFTWARE\\SAM\\Agent, туда пишет установщик). Порядок: файл → реестр → аргументы (последнее перекрывает).
use crate::{log, registry};
use serde::Deserialize;
use std::path::PathBuf;

pub const CONFIG_NAME: &str = "sam-agent.json";
pub const USAGE: &str = "Настройки: sam-agent.json рядом с exe (JSON или просто адрес, например 192.168.249.1); параметры ниже их перекрывают.
sam-agent                 — запустить в фоне (двойной клик): с правами администратора ставит службу, иначе скрытый процесс
sam-agent stop            — остановить фоновый агент и службу
sam-agent run [--server URL] [--token T] [--enroll-key K] [--interval 30] [--usage-interval 300] [--once] [--state PATH] [--fake FILE] [--config PATH]
                          — работать в этом окне (видно лог); --once — один раз и выйти
sam-agent print [--fake FILE]  — показать, что агент видит, ничего не отправляя
sam-agent install [параметры]  — установить службу (от администратора)
sam-agent uninstall            — удалить службу";

/// Файл настроек (JSON). Неизвестные ключи игнорируются — можно оставлять «_комментарии».
#[derive(Default, Deserialize)]
pub struct FileConfig {
    server: Option<String>,
    token: Option<String>,
    /// ключ регистрации: агент сам получит собственный токен ПК (обычно его кладёт установщик в реестр)
    enroll_key: Option<String>,
    /// собственный токен ПК (обычно не задаётся руками — агент получает его при регистрации)
    agent_token: Option<String>,
    interval: Option<u64>,
    usage_interval: Option<u64>,
    state: Option<String>,
}

/// Где искать настройки без --config: рядом с exe (в т.ч. «sam-agent.json.txt» — Windows прячет расширения),
/// затем %ProgramData%\sam-agent\config.json.
pub fn default_config_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        for name in [CONFIG_NAME, "sam-agent.json.txt", "sam-agent.txt", "server.txt"] {
            v.push(dir.join(name));
        }
    }
    v.push(log::data_dir().join("config.json"));
    v
}

/// «192.168.249.1» → «http://192.168.249.1:8000»; «host:9000» → «http://host:9000»; полный URL не трогаем.
pub fn normalize_server(s: &str) -> String {
    let s = s.trim().trim_matches('"').trim_end_matches('/');
    if s.is_empty() {
        return String::new();
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let after = &with_scheme[with_scheme.find("://").map(|i| i + 3).unwrap_or(0)..];
    let host_port = after.split('/').next().unwrap_or("");
    if host_port.contains(':') || host_port.is_empty() {
        with_scheme
    } else {
        format!("{with_scheme}:8000")
    }
}

#[derive(Debug)]
pub struct Config {
    pub server: String,
    /// общий токен (X-Ingest-Token) — разработка/демо
    pub token: String,
    /// ключ регистрации и токен ПК (X-Agent-Token) — рабочий режим
    pub enroll_key: Option<String>,
    pub agent_token: Option<String>,
    /// откуда настройки: «реестр», путь файла, «аргументы»
    pub source: String,
    pub interval: u64,
    /// как часто отправлять сводку запущенных процессов, с
    pub usage_interval: u64,
    pub once: bool,
    pub state: PathBuf,
    pub fake: Option<String>,
    /// Откуда взяты настройки (для лога и для регистрации службы); None — только аргументы.
    pub config_file: Option<PathBuf>,
}

/// JSON-настройки; если в файле не JSON, а просто адрес («192.168.249.1») — берём его как server.
pub fn load_file_config(path: &std::path::Path) -> Result<FileConfig, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = text.trim_start_matches('\u{feff}').trim(); // Блокнот Windows может сохранить с BOM
    if text.starts_with('{') {
        return serde_json::from_str(text).map_err(|e| format!("{}: неверный JSON ({e})", path.display()));
    }
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("");
    let addr = line
        .strip_prefix("server")
        .map(|r| r.trim_start_matches([' ', '=', ':']).trim())
        .unwrap_or(line);
    if addr.is_empty() || addr.contains(char::is_whitespace) {
        return Err(format!(
            "{}: ожидался JSON или просто адрес сервера (например 192.168.249.1)",
            path.display()
        ));
    }
    Ok(FileConfig {
        server: Some(addr.to_string()),
        ..Default::default()
    })
}

pub fn parse_config(args: &[String]) -> Result<Config, String> {
    parse_config_with(args, &default_config_paths())
}

/// Порядок: значения по умолчанию → файл настроек → аргументы командной строки.
pub fn parse_config_with(args: &[String], defaults: &[PathBuf]) -> Result<Config, String> {
    parse_config_full(args, defaults, &registry::read())
}

/// Порядок: значения по умолчанию → реестр (установщик) → файл настроек → аргументы командной строки.
pub fn parse_config_full(args: &[String], defaults: &[PathBuf], reg: &registry::RegConfig) -> Result<Config, String> {
    let mut c = Config {
        server: String::new(),
        token: "dev-token".into(),
        enroll_key: None,
        agent_token: None,
        source: "аргументы".into(),
        interval: 30,
        usage_interval: 300,
        once: false,
        state: log::data_dir().join("state.json"),
        fake: None,
        config_file: None,
    };
    // 1) реестр
    if reg.server.is_some() || reg.enroll_key.is_some() {
        c.source = format!("реестр HKLM\\{}", registry::KEY);
    }
    if let Some(v) = &reg.server {
        c.server = v.clone();
    }
    if let Some(v) = &reg.ingest_token {
        c.token = v.clone();
    }
    if let Some(v) = &reg.enroll_key {
        c.enroll_key = Some(v.clone());
    }
    if let Some(v) = &reg.agent_token {
        c.agent_token = Some(v.clone());
    }
    if let Some(v) = reg.interval {
        c.interval = v;
    }
    if let Some(v) = reg.usage_interval {
        c.usage_interval = v;
    }
    // 2) файл: явный --config или первый существующий из стандартных мест
    let explicit = args
        .iter()
        .position(|a| a == "--config")
        .map(|i| args.get(i + 1).map(PathBuf::from).ok_or("--config: нужен путь"));
    let path = match explicit {
        Some(p) => Some(p?),
        None => defaults.iter().find(|p| p.is_file()).cloned(),
    };
    if let Some(p) = path {
        let f = load_file_config(&p)?;
        if let Some(v) = f.server {
            c.server = v;
        }
        if let Some(v) = f.token {
            c.token = v;
        }
        if let Some(v) = f.enroll_key {
            c.enroll_key = Some(v);
        }
        if let Some(v) = f.agent_token {
            c.agent_token = Some(v);
        }
        if let Some(v) = f.interval {
            c.interval = v;
        }
        if let Some(v) = f.usage_interval {
            c.usage_interval = v;
        }
        if let Some(v) = f.state {
            c.state = PathBuf::from(v);
        }
        let p = std::fs::canonicalize(&p).unwrap_or(p);
        c.source = p.display().to_string();
        c.config_file = Some(p);
    }
    // 3) аргументы перекрывают всё
    let mut it = args.iter();
    while let Some(k) = it.next() {
        let mut val = |name: &str| it.next().cloned().ok_or(format!("{name}: нужно значение"));
        match k.as_str() {
            "--server" => c.server = val("--server")?,
            "--token" => c.token = val("--token")?,
            "--enroll-key" => c.enroll_key = Some(val("--enroll-key")?),
            "--interval" => c.interval = val("--interval")?.parse().map_err(|_| "--interval: число секунд")?,
            "--usage-interval" => {
                c.usage_interval = val("--usage-interval")?
                    .parse()
                    .map_err(|_| "--usage-interval: число секунд")?
            }
            "--state" => c.state = PathBuf::from(val("--state")?),
            "--fake" => c.fake = Some(val("--fake")?),
            "--config" => {
                val("--config")?;
            } // уже прочитан выше
            "--once" => c.once = true,
            other => return Err(format!("неизвестный аргумент {other}\n\n{USAGE}")),
        }
    }
    c.server = normalize_server(&c.server);
    if !(c.server.starts_with("http://") || c.server.starts_with("https://")) {
        let looked: Vec<String> = defaults.iter().map(|p| p.display().to_string()).collect();
        return Err(format!(
            "не задан адрес сервера. Положите рядом с exe файл {CONFIG_NAME} с адресом (можно просто 192.168.249.1) или укажите --server.\nИскал: {}",
            looked.join(", ")
        ));
    }
    if c.interval < 5 {
        return Err("interval: не меньше 5 секунд".into());
    }
    if c.usage_interval < 30 {
        return Err("usage_interval: не меньше 30 секунд".into());
    }
    if c.agent_token.is_none() {
        c.agent_token = registry::load_token_file(&c.state); // не служба / нет прав на реестр — токен в файле
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn config_file_then_args_override() {
        let dir = std::env::temp_dir().join(format!("sam-agent-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("sam-agent.json");
        std::fs::write(&f, "\u{feff}{\"_комментарий\":\"игнорируется\",\"server\":\"http://192.168.249.1:8000/\",\"token\":\"t1\",\"interval\":10}").unwrap();
        let none = dir.join("nope.json");

        let c = parse_config_with(&[], &[none.clone(), f.clone()]).unwrap(); // BOM и «_комментарий» не мешают
        assert_eq!(
            (c.server.as_str(), c.token.as_str(), c.interval),
            ("http://192.168.249.1:8000", "t1", 10)
        );
        assert!(c.config_file.is_some());

        let c = parse_config_with(&s(&["--token", "t2", "--interval", "60"]), std::slice::from_ref(&f)).unwrap();
        assert_eq!((c.token.as_str(), c.interval), ("t2", 60), "аргументы перекрывают файл");

        let c = parse_config_with(&s(&["--config", f.to_str().unwrap()]), &[]).unwrap();
        assert_eq!(c.server, "http://192.168.249.1:8000");

        std::fs::write(&f, "{ server: oops }").unwrap();
        assert!(parse_config_with(&[], std::slice::from_ref(&f))
            .unwrap_err()
            .contains("неверный JSON"));
        assert!(parse_config_with(&[], &[none])
            .unwrap_err()
            .contains("не задан адрес сервера"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_ip_and_server_normalization() {
        assert_eq!(normalize_server("192.168.249.1"), "http://192.168.249.1:8000");
        assert_eq!(normalize_server(" 192.168.249.1:9000/ "), "http://192.168.249.1:9000");
        assert_eq!(normalize_server("https://sam.local"), "https://sam.local:8000");
        assert_eq!(normalize_server("http://h:8000/"), "http://h:8000");
        assert_eq!(normalize_server(""), "");
        let dir = std::env::temp_dir().join(format!("sam-agent-ip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("sam-agent.json.txt"); // Windows спрятал «.txt»
        for content in [
            "192.168.249.1",
            "\u{feff}192.168.249.1\r\n",
            "# адрес\nserver = 192.168.249.1",
            "\"192.168.249.1\"",
        ] {
            std::fs::write(&f, content).unwrap();
            let c = parse_config_with(&[], &[dir.join("sam-agent.json"), f.clone()]).unwrap();
            assert_eq!(c.server, "http://192.168.249.1:8000", "{content:?}");
        }
        std::fs::write(&f, "какой-то текст с пробелами").unwrap();
        assert!(parse_config_with(&[], std::slice::from_ref(&f)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn config_parsing() {
        let c = parse_config_with(
            &s(&[
                "--server",
                "http://h:8000",
                "--token",
                "t",
                "--interval",
                "10",
                "--once",
            ]),
            &[],
        )
        .unwrap();
        assert_eq!(
            (c.server.as_str(), c.token.as_str(), c.interval, c.once),
            ("http://h:8000", "t", 10, true)
        );
        assert!(parse_config_with(&s(&["--token", "t"]), &[]).is_err(), "без --server");
        assert_eq!(
            parse_config_with(&s(&["--server", "h:8000"]), &[]).unwrap().server,
            "http://h:8000",
            "схема достраивается"
        );
        assert!(
            parse_config_with(&s(&["--server", "http://h", "--interval", "1"]), &[]).is_err(),
            "слишком частый опрос"
        );
        assert!(parse_config_with(&s(&["--server", "http://h", "--bogus"]), &[]).is_err());
    }
}
