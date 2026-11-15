//! Настройки агента в реестре (их кладёт установщик install-sam-agent.ps1) и хранение токена ПК.
//!   HKLM\SOFTWARE\SAM\Agent: Server, EnrollKey, IngestToken (необяз.), Interval, UsageInterval — пишет установщик;
//!                             AgentToken — пишет сам агент после регистрации (служба работает от SYSTEM).
//! Установщик закрывает ключ правами SYSTEM + Администраторы: пользователи ПК токен не прочитают.
//! Не Windows / нет прав на запись в реестр → токен в файле `agent-token` рядом с state.json.
#![cfg_attr(not(windows), allow(dead_code))]
use std::path::Path;

pub const KEY: &str = r"SOFTWARE\SAM\Agent";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RegConfig {
    pub server: Option<String>,
    pub enroll_key: Option<String>,
    pub ingest_token: Option<String>,
    pub agent_token: Option<String>,
    pub interval: Option<u64>,
    pub usage_interval: Option<u64>,
}

#[cfg(windows)]
pub fn read() -> RegConfig {
    use winreg::enums::*;
    use winreg::RegKey;
    let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(KEY, KEY_READ | KEY_WOW64_64KEY) else {
        return RegConfig::default();
    };
    let s = |n: &str| {
        k.get_value::<String, _>(n)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    // числа установщик пишет как DWORD, но вручную могут записать и строкой
    let n = |name: &str| {
        k.get_value::<u32, _>(name)
            .ok()
            .map(u64::from)
            .or_else(|| s(name).and_then(|v| v.parse().ok()))
    };
    RegConfig {
        server: s("Server"),
        enroll_key: s("EnrollKey"),
        ingest_token: s("IngestToken"),
        agent_token: s("AgentToken"),
        interval: n("Interval"),
        usage_interval: n("UsageInterval"),
    }
}
#[cfg(not(windows))]
pub fn read() -> RegConfig {
    RegConfig::default()
}

#[cfg(windows)]
fn save_registry(token: &str) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let (k, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .create_subkey_with_flags(KEY, KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| format!("реестр {KEY}: {e}"))?;
    k.set_value("AgentToken", &token.to_string())
        .map_err(|e| format!("реестр {KEY}\\AgentToken: {e}"))
}
#[cfg(not(windows))]
fn save_registry(_token: &str) -> Result<(), String> {
    Err("реестра нет (не Windows)".into())
}

fn token_file(state: &Path) -> std::path::PathBuf {
    state
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .join("agent-token")
}

/// Сохранить токен ПК: реестр (служба), иначе файл рядом с состоянием. Возвращает, куда сохранили.
pub fn save_token(token: &str, state: &Path) -> Result<String, String> {
    match save_registry(token) {
        Ok(()) => Ok(format!("реестр HKLM\\{KEY}\\AgentToken")),
        Err(reg_err) => {
            let f = token_file(state);
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            std::fs::write(&f, token).map_err(|e| format!("{reg_err}; файл {}: {e}", f.display()))?;
            Ok(format!("файл {}", f.display()))
        }
    }
}

/// Удалить сохранённый токен ПК (отозван сервером): иначе после перезапуска агент снова возьмёт отозванный.
pub fn forget_token(state: &Path) {
    let _ = std::fs::remove_file(token_file(state));
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(KEY, KEY_WRITE | KEY_WOW64_64KEY) {
            let _ = k.delete_value("AgentToken");
        }
    }
}

/// Токен ПК из файла (если в реестре его нет).
pub fn load_token_file(state: &Path) -> Option<String> {
    std::fs::read_to_string(token_file(state))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_file_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sam-agent-tok-{}", std::process::id()));
        let state = dir.join("state.json");
        assert_eq!(super::load_token_file(&state), None);
        let where_ = super::save_token("sat_abc", &state).unwrap();
        assert!(where_.contains("agent-token"), "{where_}");
        assert_eq!(super::load_token_file(&state).as_deref(), Some("sat_abc"));
        super::forget_token(&state);
        assert_eq!(
            super::load_token_file(&state),
            None,
            "отозванный токен удаляется из хранилища"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
