//! Лицензия КриптоПро CSP: чтение и установка ключа штатной утилитой cpconfig.exe.
//!   чтение:    cpconfig -license -view   → серийный номер (наружу только 5 последних символов), тип, срок/«постоянная»;
//!   установка: cpconfig -license -set KEY → затем перечитываем и проверяем, что встал именно этот ключ.
//! Формат вывода cpconfig разбирается терпимо (рус/англ, дата дд.мм.гггг, «N дней», «постоянная»): точный текст
//! зависит от версии CSP — сырой вывод показывается в `print` для проверки. Разбор — чистая функция, тесты ниже.
#![cfg_attr(not(windows), allow(dead_code))]
use crate::licenses::LicenseInfo;
use crate::model::Item;

pub const PRODUCT: &str = "cryptopro_csp";

/// Ключ вида XXXXX-XXXXX-XXXXX-XXXXX-XXXXX (4–6 групп по 5 символов).
pub fn find_key(text: &str) -> Option<String> {
    for tok in text.split(|c: char| c.is_whitespace() || c == ':' || c == ',' || c == ';') {
        let t = tok.trim_matches(|c: char| c == '.' || c == '"' || c == '\'');
        let groups: Vec<&str> = t.split('-').collect();
        if (4..=6).contains(&groups.len())
            && groups
                .iter()
                .all(|g| g.len() == 5 && g.chars().all(|c| c.is_ascii_alphanumeric()))
        {
            return Some(t.to_ascii_uppercase());
        }
    }
    None
}

/// Скрыть ключи в тексте (вывод cpconfig уходит на сервер): все группы, кроме последней, — «•••••».
pub fn mask_keys(text: &str) -> String {
    text.split_inclusive(|c: char| c.is_whitespace() || c == ':' || c == ',' || c == ';')
        .map(|tok| {
            let core = tok.trim_end_matches(|c: char| c.is_whitespace() || c == ':' || c == ',' || c == ';');
            let tail = &tok[core.len()..];
            let t = core.trim_matches(|c: char| c == '.' || c == '"' || c == '\'');
            let groups: Vec<&str> = t.split('-').collect();
            if (4..=6).contains(&groups.len())
                && groups
                    .iter()
                    .all(|g| g.len() == 5 && g.chars().all(|c| c.is_ascii_alphanumeric()))
            {
                let masked: Vec<&str> = groups
                    .iter()
                    .enumerate()
                    .map(|(i, g)| if i + 1 == groups.len() { *g } else { "•••••" })
                    .collect();
                format!("{}{}", core.replacen(t, &masked.join("-"), 1), tail)
            } else {
                tok.to_string()
            }
        })
        .collect()
}

/// дд.мм.гггг → «гггг-мм-дд 23:59:59» (лицензия действует до конца дня).
fn find_date(text: &str) -> Option<String> {
    let b = text.as_bytes();
    for i in 0..b.len().saturating_sub(9) {
        let Some(s) = text.get(i..i + 10) else { continue }; // позиция внутри кириллической буквы — пропустить
        let c: Vec<char> = s.chars().collect();
        if c.len() == 10
            && c[2] == '.'
            && c[5] == '.'
            && [0, 1, 3, 4, 6, 7, 8, 9].iter().all(|&k| c[k].is_ascii_digit())
        {
            let (d, m, y) = (&s[0..2], &s[3..5], &s[6..10]);
            if ("01".."32").contains(&d) && ("01".."13").contains(&m) {
                return Some(format!("{y}-{m}-{d} 23:59:59"));
            }
        }
    }
    None
}

/// «через 87 дн.» / «Expires: 90 day(s)» → число дней.
fn find_days(text: &str) -> Option<u64> {
    let low = text.to_lowercase();
    let words: Vec<&str> = low
        .split(|c: char| c.is_whitespace() || c == ':' || c == '(')
        .filter(|w| !w.is_empty())
        .collect();
    for w in words.windows(2) {
        if let Ok(n) = w[0].parse::<u64>() {
            if w[1].starts_with("дн") || w[1].starts_with("day") || w[1].starts_with("сут") || w[1].starts_with("ден")
            {
                return Some(n);
            }
        }
    }
    None
}

fn find_type(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| {
            let low = l.to_lowercase();
            (low.contains("тип лицензии") || low.contains("license type")).then(|| {
                l.split_once(':')
                    .map(|(_, v)| v.trim().trim_end_matches('.').to_string())
            })?
        })
        .filter(|s| !s.is_empty())
}

/// Разбор вывода `cpconfig -license -view`. version — из списка установленных программ.
pub fn parse_license(text: &str, version: Option<&str>, now: u64) -> LicenseInfo {
    let low = text.to_lowercase();
    let key = find_key(text);
    let kind = find_type(text);
    let permanent = ["постоянн", "бессрочн", "permanent", "unlimited"]
        .iter()
        .any(|w| low.contains(w));
    let expires_at = if permanent {
        None
    } else {
        find_date(text).or_else(|| find_days(text).map(|d| crate::log::fmt_utc(now + d * 86_400)))
    };
    let trial = kind
        .as_deref()
        .map(|k| {
            let k = k.to_lowercase();
            ["демо", "demo", "пробн", "trial", "временн", "ознаком", "evaluation"]
                .iter()
                .any(|w| k.contains(w))
        })
        .unwrap_or(false);
    // «истек/истекла/истёк» — истекла; «истекает» — это будущая дата, не истечение
    let expired_word =
        low.replace("истекает", "").contains("истек") || low.contains("истёк") || low.contains("expired");
    let past = expires_at
        .as_deref()
        .map(|d| d < crate::log::fmt_utc(now).as_str())
        .unwrap_or(false);
    let status = if expired_word || past {
        "expired"
    } else if trial {
        "trial"
    } else if key.is_some() {
        "licensed"
    } else {
        "unlicensed"
    };
    LicenseInfo {
        application: PRODUCT.into(),
        product: format!("КриптоПро CSP{}", version.map(|v| format!(" {v}")).unwrap_or_default()),
        description: Some(if permanent {
            "Постоянная".into()
        } else {
            kind.clone().unwrap_or_default()
        })
        .filter(|s: &String| !s.is_empty()),
        channel: kind,
        partial_key: key
            .as_deref()
            .map(|k| k.replace('-', ""))
            .map(|k| k[k.len().saturating_sub(5)..].to_string()),
        status: status.into(),
        status_code: 0,
        expires_at,
    }
}

fn csp_item(items: &[Item]) -> Option<&Item> {
    items.iter().find(|i| {
        let n = i.name.to_lowercase();
        (n.contains("криптопро csp") || n.contains("cryptopro csp")) && !n.contains("plugin") && !n.contains("плагин")
    })
}

/// Установлен ли КриптоПро CSP (по списку программ) и его версия.
pub fn installed_version(items: &[Item]) -> Option<Option<String>> {
    csp_item(items).map(|i| i.version.clone())
}

/// Где искать cpconfig.exe: папка установки из реестра (на ВМ — «Program Files (x86)\Crypto Pro\CSP»), затем стандартные.
pub fn cpconfig_candidates(items: &[Item]) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    if let Some(loc) = csp_item(items).and_then(|i| i.install_location.clone()) {
        v.push(format!("{}\\cpconfig.exe", loc.trim_end_matches('\\')));
    }
    for base in [
        r"C:\Program Files\Crypto Pro\CSP",
        r"C:\Program Files (x86)\Crypto Pro\CSP",
    ] {
        let p = format!("{base}\\cpconfig.exe");
        if !v.iter().any(|x| x.eq_ignore_ascii_case(&p)) {
            v.push(p);
        }
    }
    v
}

pub fn valid_key(key: &str) -> bool {
    find_key(key).as_deref() == Some(key.trim().to_ascii_uppercase().as_str())
}

#[cfg(windows)]
mod imp {
    pub fn cpconfig(candidates: &[String]) -> Option<String> {
        candidates
            .iter()
            .find(|p| std::path::Path::new(p.as_str()).is_file())
            .cloned()
    }

    /// Для диагностики: какие exe лежат в папках КриптоПро.
    pub fn list_exes(candidates: &[String]) -> String {
        let mut out = Vec::new();
        for c in candidates {
            let dir = std::path::Path::new(c.as_str()).parent().map(|d| d.to_path_buf());
            let Some(dir) = dir else { continue };
            let names: Vec<String> = std::fs::read_dir(&dir)
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .filter(|n| n.to_lowercase().ends_with(".exe"))
                        .collect()
                })
                .unwrap_or_default();
            out.push(format!(
                "{}: {}",
                dir.display(),
                if names.is_empty() {
                    "нет папки или exe".into()
                } else {
                    names.join(", ")
                }
            ));
        }
        out.join("; ")
    }

    pub use crate::exec::run;
}

// ---------- Windows: серийный номер в реестре установщика (MSI) ----------
// На Windows консольного cpconfig.exe НЕТ (только апплет cpconfig.cpl) — поэтому на ВМ он «не находился».
// Серийный номер, введённый при установке или в апплете, лежит открытым текстом в свойствах MSI-продукта:
//   HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData\S-1-5-18\Products\<код>\InstallProperties
//   ProductID = серийный номер (без дефисов), DisplayName/DisplayVersion/InstallDate — там же.
// Коды продукта (упакованный GUID): 3.6 05480A45343B0B0429E4860F13549069, 3.9 68A52D936E5ACF24C9F8FE4A1C830BC8,
// 4.0 7AB5E7046046FB044ACD63458B5F481C, 5.0 08F19F05793DC7340B8C2621D83E5BE5; ищем и по DisplayName (у R2/R3 коды другие).
// Нет серийного номера → CSP работает по временной лицензии 3 месяца с даты установки.
pub const MSI_PRODUCTS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData\S-1-5-18\Products";
pub const KNOWN_CODES: [&str; 4] = [
    "05480A45343B0B0429E4860F13549069",
    "68A52D936E5ACF24C9F8FE4A1C830BC8",
    "7AB5E7046046FB044ACD63458B5F481C",
    "08F19F05793DC7340B8C2621D83E5BE5",
];
pub const TRIAL_DAYS: u64 = 90;

/// Строка InstallProperties продукта КриптоПро CSP.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MsiProps {
    pub code: String,
    pub product_id: Option<String>,
    pub version: Option<String>,
    pub install_date: Option<String>, // YYYYMMDD
}

/// Серийный номер из ProductID: только буквы/цифры, ≥ 20 символов (у CSP — 25). «none», пусто, мусор → None.
pub fn serial_of(product_id: Option<&str>) -> Option<String> {
    let s: String = product_id?
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    (s.len() >= 20).then_some(s)
}

/// «20251114» → секунды UTC начала дня.
fn yyyymmdd(s: &str) -> Option<u64> {
    let d = s.trim();
    (d.len() == 8).then(|| crate::licenses::parse_cim_datetime(&format!("{d}000000")))?
}

/// Лицензия по свойствам MSI. Срок постоянной/годовой лицензии в номере закодирован (формат закрыт) —
/// не угадываем: expires_at = None, срок сверяется с хранилищем ключей на сервере.
pub fn from_msi(p: &MsiProps, now: u64) -> LicenseInfo {
    let product = format!(
        "КриптоПро CSP{}",
        p.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default()
    );
    match serial_of(p.product_id.as_deref()) {
        Some(sn) => LicenseInfo {
            application: PRODUCT.into(),
            product,
            description: Some("серийный номер из реестра установщика (ProductID)".into()),
            channel: Some("Серийный номер".into()),
            partial_key: Some(sn[sn.len() - 5..].to_string()),
            status: "licensed".into(),
            status_code: 0,
            expires_at: None,
        },
        None => {
            let end = p
                .install_date
                .as_deref()
                .and_then(yyyymmdd)
                .map(|t| t + TRIAL_DAYS * 86_400);
            LicenseInfo {
                application: PRODUCT.into(),
                product,
                description: Some("серийный номер не введён — временная лицензия 3 месяца с даты установки".into()),
                channel: Some("Временная".into()),
                partial_key: None,
                status: if end.is_some_and(|e| e < now) {
                    "expired"
                } else {
                    "trial"
                }
                .into(),
                status_code: 0,
                expires_at: end.map(crate::log::fmt_utc),
            }
        }
    }
}

/// Подходит ли MSI-продукт: известный код или имя «КриптоПро CSP» / «CryptoPro CSP» (без плагинов).
pub fn is_csp_product(code: &str, display_name: &str) -> bool {
    let n = display_name.to_lowercase();
    KNOWN_CODES.contains(&code.to_ascii_uppercase().as_str())
        || ((n.contains("криптопро csp") || n.contains("cryptopro csp"))
            && !n.contains("plugin")
            && !n.contains("плагин"))
}

#[cfg(windows)]
mod msi {
    use super::*;
    use winreg::enums::*;
    use winreg::RegKey;

    /// Все продукты КриптоПро CSP в реестре установщика (обычно один).
    pub fn find() -> Vec<MsiProps> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let Ok(root) = hklm.open_subkey_with_flags(MSI_PRODUCTS, KEY_READ | KEY_WOW64_64KEY) else {
            return vec![];
        };
        let mut out = Vec::new();
        for code in root.enum_keys().flatten() {
            let Ok(k) = root.open_subkey_with_flags(format!(r"{code}\InstallProperties"), KEY_READ | KEY_WOW64_64KEY)
            else {
                continue;
            };
            let get = |v: &str| {
                k.get_value::<String, _>(v)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            if !is_csp_product(&code, &get("DisplayName").unwrap_or_default()) {
                continue;
            }
            out.push(MsiProps {
                code,
                product_id: get("ProductID"),
                version: get("DisplayVersion"),
                install_date: get("InstallDate"),
            });
        }
        out
    }

    /// Записать серийный номер в ProductID (так же его хранит апплет «КриптоПро CSP» → «Ввод лицензии»).
    pub fn write_serial(code: &str, serial: &str) -> Result<(), String> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let k = hklm
            .open_subkey_with_flags(
                format!(r"{MSI_PRODUCTS}\{code}\InstallProperties"),
                KEY_READ | KEY_SET_VALUE | KEY_WOW64_64KEY,
            )
            .map_err(|e| format!("реестр установщика КриптоПро: {e} (нужны права SYSTEM/администратора)"))?;
        k.set_value("ProductID", &serial.to_string())
            .map_err(|e| format!("запись ProductID: {e}"))
    }
}

/// Сырой вывод для `print`: свойства MSI (серийник замаскирован) и, если есть, `cpconfig -license -view`.
/// None — КриптоПро не установлен; Err — ничего прочитать не удалось (с диагностикой).
#[cfg(windows)]
pub fn raw_view(items: &[Item]) -> Option<Result<String, String>> {
    let found = msi::find();
    if installed_version(items).is_none() && found.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = found
        .iter()
        .map(|p| {
            format!(
                "[MSI {}] ProductID={} DisplayVersion={} InstallDate={}",
                p.code,
                serial_of(p.product_id.as_deref())
                    .map(|s| format!("•••••{}", &s[s.len() - 5..]))
                    .unwrap_or_else(|| "(нет)".into()),
                p.version.as_deref().unwrap_or("?"),
                p.install_date.as_deref().unwrap_or("?")
            )
        })
        .collect();
    let cands = cpconfig_candidates(items);
    match imp::cpconfig(&cands) {
        Some(exe) => parts.push(match imp::run(&exe, &["-license", "-view"]) {
            Ok((_, t)) => format!("[{exe}]\n{}", mask_keys(&t)),
            Err(e) => format!("[{exe}] ошибка: {e}"),
        }),
        None if found.is_empty() => {
            return Some(Err(format!(
                "нет ни свойств MSI, ни cpconfig.exe. Искал: {}. Содержимое папок: {}",
                cands.join(", "),
                imp::list_exes(&cands)
            )))
        }
        None => {}
    }
    Some(Ok(parts.join("\n")))
}
#[cfg(not(windows))]
pub fn raw_view(_items: &[Item]) -> Option<Result<String, String>> {
    None
}

/// Сырой вывод cpconfig (если утилита есть: старые версии/Linux-сборки). Только для collect.
#[cfg(windows)]
fn cpconfig_view(items: &[Item]) -> Option<Result<String, String>> {
    let exe = imp::cpconfig(&cpconfig_candidates(items))?;
    Some(imp::run(&exe, &["-license", "-view"]).map(|(_, t)| t))
}
#[cfg(not(windows))]
fn cpconfig_view(_items: &[Item]) -> Option<Result<String, String>> {
    None
}

/// Лицензия КриптоПро для снимка: реестр установщика (основной путь на Windows) → cpconfig → «unknown».
pub fn collect(items: &[Item], now: u64) -> Option<LicenseInfo> {
    #[cfg(windows)]
    if let Some(p) = msi::find().into_iter().next() {
        let mut p = p;
        if p.version.is_none() {
            p.version = installed_version(items).flatten();
        }
        return Some(from_msi(&p, now));
    }
    let version = installed_version(items)?;
    let view = cpconfig_view(items).unwrap_or_else(|| Err("нет свойств MSI и cpconfig.exe".into()));
    match view {
        Ok(text) => Some(parse_license(&text, version.as_deref(), now)),
        Err(e) => {
            crate::log::error(&format!("КриптоПро: {e}"));
            Some(LicenseInfo {
                application: PRODUCT.into(),
                product: format!("КриптоПро CSP{}", version.map(|v| format!(" {v}")).unwrap_or_default()),
                description: Some("лицензию прочитать не удалось (см. agent.log)".into()),
                channel: None,
                partial_key: None,
                status: "unknown".into(),
                status_code: 0,
                expires_at: None,
            })
        }
    }
}

/// Установить ключ. Ok(вывод) только если после установки cpconfig показывает этот же ключ.
#[cfg(windows)]
pub fn apply(key: &str) -> Result<String, String> {
    if !valid_key(key) {
        return Err("неверный формат ключа".into());
    }
    let items = crate::collect::items().unwrap_or_default();
    let Some(exe) = imp::cpconfig(&cpconfig_candidates(&items)) else {
        // обычный случай на Windows: cpconfig.exe нет → ProductID в реестре установщика, затем перечитать
        let p = msi::find()
            .into_iter()
            .next()
            .ok_or("КриптоПро CSP не установлен (нет в реестре установщика)")?;
        let serial = serial_of(Some(key)).ok_or("неверный формат ключа")?;
        msi::write_serial(&p.code, &serial)?;
        let now_sn = msi::find()
            .into_iter()
            .find(|x| x.code == p.code)
            .and_then(|x| serial_of(x.product_id.as_deref()));
        return if now_sn.as_deref() == Some(serial.as_str()) {
            Ok(format!(
                "серийный номер •••••{} записан в ProductID (MSI {}); проверка: «КриптоПро CSP» → «Общие»",
                &serial[serial.len() - 5..],
                p.code
            ))
        } else {
            Err("ProductID после записи не совпал с ключом".into())
        };
    };
    let (ok, out) = imp::run(&exe, &["-license", "-set", key.trim()])?;
    let (_, view) = imp::run(&exe, &["-license", "-view"])?;
    let now_key = find_key(&view);
    if ok && now_key.as_deref() == Some(key.trim().to_ascii_uppercase().as_str()) {
        Ok(mask_keys(format!("{out}\n{view}").trim()))
    } else {
        Err(mask_keys(
            format!(
                "cpconfig: {}\n{}",
                if out.is_empty() {
                    "ключ не принят"
                } else {
                    &out
                },
                view
            )
            .trim(),
        ))
    }
}
#[cfg(not(windows))]
pub fn apply(key: &str) -> Result<String, String> {
    if !valid_key(key) {
        return Err("неверный формат ключа".into());
    }
    Err("установка ключа поддерживается только на Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: u64 = 1_763_078_400; // 2025-11-14

    #[test]
    fn keys_masked_in_output() {
        let t = "Серийный номер: 4040E-Q0000-0AB1C-D2E3F-7KX2M\nСрок действия: Постоянная";
        let m = mask_keys(t);
        assert!(
            !m.contains("0AB1C") && m.contains("•••••-•••••-•••••-•••••-7KX2M") && m.contains("Срок действия"),
            "{m}"
        );
        assert_eq!(mask_keys("нет ключа, 12345"), "нет ключа, 12345");
    }

    #[test]
    fn permanent_russian() {
        let t = "Серийный номер: 4040E-Q0000-0AB1C-D2E3F-7KX2M\nСрок действия: Постоянная\nТип лицензии: Клиентская.";
        let l = parse_license(t, Some("5.0.12000"), NOW);
        assert_eq!(
            (l.status.as_str(), l.partial_key.as_deref(), l.expires_at.as_deref()),
            ("licensed", Some("7KX2M"), None)
        );
        assert_eq!(
            (l.product.as_str(), l.channel.as_deref()),
            ("КриптоПро CSP 5.0.12000", Some("Клиентская"))
        );
    }

    #[test]
    fn annual_with_date_and_english_days() {
        let l = parse_license(
            "License key: 50501-B0000-03XYZ-QWE34-9PL4T\nExpires: 26.11.2026\nLicense type: Client",
            None,
            NOW,
        );
        assert_eq!(
            (l.status.as_str(), l.expires_at.as_deref()),
            ("licensed", Some("2026-11-26 23:59:59"))
        );
        let l = parse_license(
            "License validity:\n40400-Q0000-00000-00000-00000\nExpires: 87 day(s)\nLicense type: Trial.",
            None,
            NOW,
        );
        assert_eq!(
            (l.status.as_str(), l.expires_at.as_deref()),
            ("trial", Some("2026-02-09 00:00:00"))
        );
    }

    #[test]
    fn expired_and_no_key() {
        assert_eq!(
            parse_license("Срок действия лицензии истек", None, NOW).status,
            "expired"
        );
        assert_eq!(
            parse_license(
                "Серийный номер: 4040E-Q0000-0AB1C-D2E3F-7KX2M\nИстекает: 01.01.2020",
                None,
                NOW
            )
            .status,
            "expired"
        );
        assert_eq!(parse_license("ничего полезного", None, NOW).status, "unlicensed");
    }

    #[test]
    fn msi_serial_and_trial() {
        assert_eq!(
            serial_of(Some("5050A-B0000-0AB1C-D2E3F-7KX2M")).as_deref(),
            Some("5050AB00000AB1CD2E3F7KX2M")
        );
        assert_eq!(serial_of(Some("none")), None);
        assert_eq!(serial_of(Some("  ")), None);
        let p = MsiProps {
            code: KNOWN_CODES[3].into(),
            product_id: Some("5050AB00000AB1CD2E3F7KX2M".into()),
            version: Some("5.0.13820".into()),
            install_date: Some("20251001".into()),
        };
        let l = from_msi(&p, NOW);
        assert_eq!(
            (l.status.as_str(), l.partial_key.as_deref(), l.expires_at.as_deref()),
            ("licensed", Some("7KX2M"), None)
        );
        assert_eq!(l.product, "КриптоПро CSP 5.0.13820");
        // без серийника: 90 дней с даты установки
        let t = from_msi(
            &MsiProps {
                product_id: None,
                ..p.clone()
            },
            NOW,
        );
        assert_eq!(
            (t.status.as_str(), t.expires_at.as_deref(), t.partial_key),
            ("trial", Some("2025-12-30 00:00:00"), None)
        );
        let old = from_msi(
            &MsiProps {
                product_id: None,
                install_date: Some("20240101".into()),
                ..p
            },
            NOW,
        );
        assert_eq!(old.status, "expired");
        assert!(is_csp_product("7ab5e7046046fb044acd63458b5f481c", ""));
        assert!(is_csp_product("X", "КриптоПро CSP"));
        assert!(!is_csp_product("X", "КриптоПро ЭЦП Browser plug-in"));
    }

    #[test]
    fn key_validation_and_install_detection() {
        assert!(valid_key("50501-C0000-04RTY-UIO56-3MN8R"));
        assert!(!valid_key("50501-C0000 & del *"));
        assert!(!valid_key("abc"));
        let it = |n: &str| Item {
            name: n.into(),
            publisher: None,
            version: Some("5.0.12000".into()),
            install_date: None,
            install_location: None,
        };
        assert_eq!(
            installed_version(&[it("КриптоПро CSP")]),
            Some(Some("5.0.12000".into()))
        );
        assert_eq!(installed_version(&[it("КриптоПро ЭЦП Browser plug-in")]), None);
        assert_eq!(
            installed_version(&[it("CryptoPro CSP")]),
            Some(Some("5.0.12000".into())),
            "английское имя (реальная ВМ: CryptoPro CSP 5.0.13820)"
        );
        let mut csp = it("CryptoPro CSP");
        csp.install_location = Some(r"C:\Program Files (x86)\Crypto Pro\CSP\".into()); // как на ВМ
        let c = cpconfig_candidates(&[csp]);
        assert_eq!(c[0], r"C:\Program Files (x86)\Crypto Pro\CSP\cpconfig.exe");
        assert_eq!(c.len(), 2, "стандартный путь (x86) не дублируется");
    }
}
