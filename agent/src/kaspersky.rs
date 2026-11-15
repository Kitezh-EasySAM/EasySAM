//! Лицензия Kaspersky Endpoint Security для Windows: `avp.com LICENSE /CHECK` (штатная утилита KES, есть с версии 12.x).
//! Документация (KES 12.x, «LICENSE. Лицензирование»): по каждому ключу (активный, резервный, Add-on) выводятся
//! название, идентификатор лицензии, тип (пробная/коммерческая/подписка/бета), дата активации, дата окончания, дней до окончания.
//! Точный текст вывода в документации не приведён и зависит от языка → разбор терпимый (рус/англ), сырой вывод
//! (ключи замаскированы) показывается в `print` для сверки.
//! KES 10/11: команды LICENSE /CHECK нет → status «unknown» с пояснением; там источник — Kaspersky Security Center
//! (Open API LicenseKeys: EnumKeys + KLLIC_NHOSTS_ASCURRENT) — см. docs/LICENSES_RU.md.
//! Наружу — только 5 последних символов идентификатора/кода активации (правило 7). Один ключ KES по замыслу
//! стоит на многих ПК — сервер не считает это «переиспользованием» (services/licenses.ts).
#![cfg_attr(not(windows), allow(dead_code))]
use crate::licenses::LicenseInfo;
use crate::model::Item;

pub const PRODUCT: &str = "kaspersky_kes";

/// Установленный KES (а не плагин управления, агент KSC, консоль, версии для Mac/Linux/мобильных).
pub fn kes_item(items: &[Item]) -> Option<&Item> {
    items.iter().find(|i| {
        let n = i.name.to_lowercase();
        n.contains("kaspersky endpoint security")
            && ![
                "плагин",
                "plug-in",
                "plugin",
                "агент",
                "agent",
                "консоль",
                "console",
                "mac",
                "linux",
                "мобильн",
                "mobile",
                "android",
                "ios",
            ]
            .iter()
            .any(|w| n.contains(w))
    })
}

/// Где искать avp.com: папка из реестра (InstallLocation), затем стандартные папки KES 10–12.
pub fn avp_candidates(items: &[Item]) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    if let Some(loc) = kes_item(items).and_then(|i| i.install_location.clone()) {
        v.push(format!("{}\\avp.com", loc.trim_end_matches('\\')));
    }
    for base in [
        r"C:\Program Files (x86)\Kaspersky Lab",
        r"C:\Program Files\Kaspersky Lab",
    ] {
        // KES 11/12: «KES.12.6.0», KES 10: «Kaspersky Endpoint Security 10 for Windows»
        let Ok(rd) = std::fs::read_dir(base) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if n.starts_with("kes") || n.contains("endpoint security") {
                let p = format!("{}\\avp.com", e.path().display());
                if !v.iter().any(|x| x.eq_ignore_ascii_case(&p)) {
                    v.push(p);
                }
            }
        }
    }
    v
}

/// Идентификатор лицензии KES вида 3084-000789-456AB78C (4-6-8 hex) или код активации XXXXX-XXXXX-XXXXX-XXXXX.
pub fn find_license_id(text: &str) -> Option<String> {
    for tok in text.split(|c: char| c.is_whitespace() || c == ':' || c == ',' || c == ';' || c == '(' || c == ')') {
        let t = tok.trim_matches(|c: char| c == '.' || c == '"' || c == '\'');
        let g: Vec<&str> = t.split('-').collect();
        let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
        if g.len() == 3 && g[0].len() == 4 && g[1].len() == 6 && g[2].len() == 8 && g.iter().all(|s| hex(s)) {
            return Some(t.to_ascii_uppercase());
        }
    }
    crate::cryptopro::find_key(text)
}

/// Дата в строке: дд.мм.гггг, гггг-мм-дд или дд/мм/гггг → «гггг-мм-дд 23:59:59».
pub fn find_date_any(line: &str) -> Option<String> {
    let c: Vec<char> = line.chars().collect();
    let dig = |s: &[char]| s.iter().all(|x| x.is_ascii_digit());
    for i in 0..c.len().saturating_sub(9) {
        let w = &c[i..i + 10];
        let s: String = w.iter().collect();
        let (y, m, d) =
            if (w[2] == '.' || w[2] == '/') && w[5] == w[2] && dig(&w[0..2]) && dig(&w[3..5]) && dig(&w[6..10]) {
                (s[6..10].to_string(), s[3..5].to_string(), s[0..2].to_string())
            } else if w[4] == '-' && w[7] == '-' && dig(&w[0..4]) && dig(&w[5..7]) && dig(&w[8..10]) {
                (s[0..4].to_string(), s[5..7].to_string(), s[8..10].to_string())
            } else {
                continue;
            };
        if ("01".."32").contains(&d.as_str()) && ("01".."13").contains(&m.as_str()) {
            return Some(format!("{y}-{m}-{d} 23:59:59"));
        }
    }
    None
}

/// Первое число в строке.
fn first_number(line: &str) -> Option<u64> {
    line.split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty() && s.len() <= 5)
        .and_then(|s| s.parse().ok())
}

fn has(low: &str, words: &[&str]) -> bool {
    words.iter().any(|w| low.contains(w))
}

/// Разбор вывода `avp.com LICENSE /CHECK`. Берётся первый блок с ключом (активный); резервные — в описании.
pub fn parse_check(text: &str, version: Option<&str>, now: u64) -> LicenseInfo {
    let product = format!(
        "Kaspersky Endpoint Security{}",
        version.map(|v| format!(" {v}")).unwrap_or_default()
    );
    let low = text.to_lowercase();
    let unknown = |why: String| LicenseInfo {
        application: PRODUCT.into(),
        product: product.clone(),
        description: Some(why),
        channel: None,
        partial_key: None,
        status: "unknown".into(),
        status_code: 0,
        expires_at: None,
    };
    if text.trim().is_empty()
        || has(
            &low,
            &[
                "unknown command",
                "неизвестн",
                "invalid command",
                "неверная команда",
                "not supported",
                "не поддерживается",
                "usage:",
                "использование:",
            ],
        )
    {
        return unknown(format!(
            "KES {}: нет команды LICENSE /CHECK (есть с 12.x) — лицензию смотреть в Kaspersky Security Center",
            version.unwrap_or("?")
        ));
    }
    if has(&low, &["access denied", "доступ запрещ", "password", "парол"]) && find_license_id(text).is_none()
    {
        return unknown("avp.com: нужен пароль защиты KES (/login /password) — лицензию смотреть в KSC".into());
    }
    let no_license = has(
        &low,
        &[
            "no license",
            "нет лицензи",
            "not activated",
            "не активирован",
            "ключ не добавлен",
            "no key",
            "отсутствует",
        ],
    );

    // активный ключ — первый блок, где есть идентификатор; блоки разделены пустыми строками
    let blocks: Vec<&str> = text.split("\n\n").map(str::trim).filter(|b| !b.is_empty()).collect();
    let active = blocks
        .iter()
        .copied()
        .find(|b| find_license_id(b).is_some())
        .unwrap_or(text);
    let reserve = blocks
        .iter()
        .filter(|b| find_license_id(b).is_some())
        .count()
        .saturating_sub(1);
    let id = find_license_id(active);
    let mut kind: Option<String> = None;
    let mut expires: Option<String> = None;
    let mut days: Option<u64> = None;
    for line in active.lines() {
        let l = line.to_lowercase();
        if kind.is_none() && (l.contains("тип") || l.contains("type")) {
            kind = Some(
                if has(&l, &["пробн", "trial", "ознаком"]) {
                    "Пробная"
                } else if has(&l, &["подписк", "subscription"]) {
                    "Подписка"
                } else if has(&l, &["бета", "beta"]) {
                    "Бета"
                } else if has(&l, &["коммерч", "commercial"]) {
                    "Коммерческая"
                } else {
                    continue;
                }
                .into(),
            );
        }
        let is_days = has(&l, &["дней", "days", "осталось", "remaining"]);
        if is_days && days.is_none() {
            days = first_number(line);
        } else if expires.is_none()
            && has(
                &l,
                &[
                    "окончан",
                    "истеч",
                    "истека",
                    "expir",
                    "действует до",
                    "valid until",
                    "end date",
                ],
            )
        {
            expires = find_date_any(line);
        }
    }
    let expires_at = expires.or_else(|| days.map(|d| crate::log::fmt_utc(now + d * 86_400)));
    let past = expires_at
        .as_deref()
        .is_some_and(|d| d < crate::log::fmt_utc(now).as_str());
    let expired_word = has(
        &low.replace("истекает", "")
            .replace("истечения", "")
            .replace("expiration", ""),
        &["истек", "истёк", "expired", "черн", "blacklist", "заблокирован"],
    );
    let status = if past || expired_word {
        "expired"
    } else if kind.as_deref() == Some("Пробная") || kind.as_deref() == Some("Бета") {
        "trial"
    } else if id.is_some() {
        "licensed"
    } else if no_license {
        "unlicensed"
    } else {
        return unknown("вывод avp.com не разобран — сверить с `sam-agent print`".into());
    };
    let tail = id.as_deref().map(|k| {
        let a: String = k.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        a[a.len().saturating_sub(5)..].to_string()
    });
    LicenseInfo {
        application: PRODUCT.into(),
        product,
        description: Some(format!(
            "{}{}",
            kind.clone().unwrap_or_else(|| "Лицензия".into()),
            if reserve > 0 {
                format!(", резервных ключей: {reserve}")
            } else {
                String::new()
            }
        )),
        channel: kind,
        partial_key: tail,
        status: status.into(),
        status_code: 0,
        expires_at,
    }
}

/// Скрыть ключи в выводе avp.com: идентификатор и коды активации — только 5 последних символов.
pub fn mask(text: &str) -> String {
    let t = crate::cryptopro::mask_keys(text);
    t.split_inclusive(char::is_whitespace)
        .map(|tok| match find_license_id(tok.trim()) {
            Some(id) if id.len() == 20 && tok.contains(&id) => {
                tok.replace(&id, &format!("••••-••••••-•••{}", &id[15..]))
            }
            _ => tok.to_string(),
        })
        .collect()
}

/// Вывод `avp.com LICENSE /CHECK` как есть (с ключами — только для разбора здесь же). None — KES не установлен.
#[cfg(windows)]
fn check_output(items: &[Item]) -> Option<Result<(String, String), String>> {
    kes_item(items)?;
    let cands = avp_candidates(items);
    let Some(exe) = cands.iter().find(|p| std::path::Path::new(p.as_str()).is_file()) else {
        return Some(Err(format!("avp.com не найден. Искал: {}", cands.join(", "))));
    };
    Some(crate::exec::run(exe, &["LICENSE", "/CHECK"]).map(|(_, t)| (exe.clone(), t)))
}
#[cfg(not(windows))]
fn check_output(_items: &[Item]) -> Option<Result<(String, String), String>> {
    None
}

/// Сырой вывод для `print` (ключи замаскированы). None — KES не установлен.
pub fn raw_view(items: &[Item]) -> Option<Result<String, String>> {
    check_output(items).map(|r| r.map(|(exe, t)| format!("[{exe}]\n{}", mask(&t))))
}

/// Лицензия KES для снимка. KES стоит, а прочитать не удалось → status «unknown» с причиной.
pub fn collect(items: &[Item], now: u64) -> Option<LicenseInfo> {
    let version = kes_item(items)?.version.clone();
    match check_output(items)? {
        Ok((_, text)) => Some(parse_check(&text, version.as_deref(), now)),
        Err(e) => {
            crate::log::error(&format!("Kaspersky: {e}"));
            let mut l = parse_check("", version.as_deref(), now);
            l.description = Some(format!("лицензию прочитать не удалось: {e}"));
            Some(l)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: u64 = 1_763_078_400; // 2025-11-14

    fn it(n: &str) -> Item {
        Item {
            name: n.into(),
            publisher: Some("АО \"Лаборатория Касперского\"".into()),
            version: Some("12.6.0.438".into()),
            install_date: None,
            install_location: None,
        }
    }

    #[test]
    fn detects_kes_not_plugins() {
        assert!(kes_item(&[it("Kaspersky Endpoint Security для Windows")]).is_some());
        assert!(kes_item(&[it(
            "Плагин управления Kaspersky Endpoint Security 10 Service Pack 1 для Windows"
        )])
        .is_none());
        assert!(kes_item(&[it("Агент администрирования Kaspersky Security Center 10")]).is_none());
        assert!(kes_item(&[it("Kaspersky Endpoint Security 10 SP1 для Linux")]).is_none());
        let mut k = it("Kaspersky Endpoint Security для Windows");
        k.install_location = Some(r"C:\Program Files (x86)\Kaspersky Lab\KES.12.6.0\".into());
        assert_eq!(
            avp_candidates(&[k])[0],
            r"C:\Program Files (x86)\Kaspersky Lab\KES.12.6.0\avp.com"
        );
    }

    #[test]
    fn commercial_russian_with_reserve() {
        let t = "Лицензия: Kaspersky Endpoint Security для бизнеса – Стандартный\nИдентификатор лицензии: 3084-000789-456AB78C\n\
                 Тип лицензии: Коммерческая\nДата активации: 01.12.2025\nДата окончания срока действия: 01.12.2026\nДней до окончания: 382\n\n\
                 Лицензия: Kaspersky Endpoint Security для бизнеса – Стандартный\nИдентификатор лицензии: 3084-000790-111AB22D\nТип лицензии: Коммерческая";
        let l = parse_check(t, Some("12.6.0.438"), NOW);
        assert_eq!(
            (l.status.as_str(), l.partial_key.as_deref(), l.expires_at.as_deref()),
            ("licensed", Some("AB78C"), Some("2026-12-01 23:59:59"))
        );
        assert_eq!(
            (l.channel.as_deref(), l.description.as_deref()),
            (Some("Коммерческая"), Some("Коммерческая, резервных ключей: 1"))
        );
        assert_eq!(l.application, PRODUCT);
    }

    #[test]
    fn trial_english_days_only() {
        let t = "License name: Kaspersky Endpoint Security for Business Select\nLicense ID: 0F2A-000123-ABCDEF01\nLicense type: Trial\nDays until expiration: 25";
        let l = parse_check(t, None, NOW);
        assert_eq!(
            (l.status.as_str(), l.expires_at.as_deref(), l.partial_key.as_deref()),
            ("trial", Some("2025-12-09 00:00:00"), Some("DEF01"))
        );
    }

    #[test]
    fn expired_and_old_versions() {
        let t = "Идентификатор лицензии: 3084-000789-456AB78C\nТип лицензии: Коммерческая\nДата окончания: 2025-01-31";
        assert_eq!(parse_check(t, None, NOW).status, "expired");
        let old = parse_check("Неизвестная команда LICENSE /CHECK", Some("11.11.0"), NOW);
        assert_eq!(old.status, "unknown");
        assert!(old.description.unwrap().contains("Kaspersky Security Center"));
        assert_eq!(parse_check("", Some("10.3"), NOW).status, "unknown");
        assert_eq!(parse_check("Ключ не добавлен", None, NOW).status, "unlicensed");
        assert_eq!(parse_check("что-то непонятное", None, NOW).status, "unknown");
    }

    #[test]
    fn masks_ids_and_codes() {
        let m = mask("Идентификатор лицензии: 3084-000789-456AB78C\nКод активации: AAAAA-BBBBB-CCCCC-DDDDD");
        assert!(
            !m.contains("000789") && m.contains("AB78C") && !m.contains("BBBBB") && m.contains("DDDDD"),
            "{m}"
        );
        assert_eq!(
            parse_check(
                "Идентификатор лицензии: 3084-000789-456AB78C\nТип: Коммерческая",
                None,
                NOW
            )
            .partial_key
            .as_deref(),
            Some("AB78C")
        );
        assert_eq!(find_date_any("до 14/11/2026"), Some("2026-11-14 23:59:59".into()));
        assert_eq!(find_date_any("версия 12.6.0.438"), None);
    }
}
