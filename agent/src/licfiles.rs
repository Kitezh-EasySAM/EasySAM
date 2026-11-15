//! Лицензии российского ПО, которые лежат файлами на ПК (без утилит и прав сверх SYSTEM):
//!   nanoCAD (Нанософт) — C:\ProgramData\Nanosoft\RegWizard\Licenses\*.lic (до ~22), …\License Manager\Licenses\*.lic (23+).
//!     Имя файла «xx-yyyyy.lic», yyyyy — окончание серийного номера; файл зашифрован → срок не читаем.
//!     Нет файлов при установленном nanoCAD → вероятно, сетевая лицензия (сервер Нанософт) — status «unknown».
//!   1С:Предприятие — C:\ProgramData\1C\licenses\*.lic (программные лицензии, привязаны к ПК); имя — номер комплекта-пин.
//!     Подробности (комплект, кол-во мест) — `ring license info` (нужна Java, на ПК обычно нет) — не вызываем.
//!   Dr.Web — ключевой файл *.key (agent.key / drweb32.key / SL….key) в папке установки: INI, Expires=, Applications=.
//! Наружу — только 5 последних символов номера (правило 7). Содержимое файлов на сервер не отправляется.
//! Обход папок — std::fs, поэтому логика проверяется на Linux на временных папках (тесты ниже).
use crate::licenses::LicenseInfo;
use crate::model::Item;
use std::path::Path;

pub const NANOCAD: &str = "nanocad";
pub const ONEC: &str = "1c_enterprise";
pub const DRWEB: &str = "drweb";

/// Папки поиска (на Windows — ProgramData; в тестах — временная папка).
pub struct Roots {
    pub program_data: String,
}

impl Roots {
    pub fn system() -> Self {
        Roots {
            program_data: std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into()),
        }
    }
}

fn tail5(s: &str) -> Option<String> {
    let a: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    (a.len() >= 5).then(|| a[a.len() - 5..].to_string())
}

/// Файлы с расширением ext в папке (без рекурсии), по имени.
fn files(dir: &Path, ext: &str) -> Vec<std::path::PathBuf> {
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn stem(p: &Path) -> String {
    p.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn lic(
    app: &str,
    product: String,
    description: String,
    channel: Option<&str>,
    key: Option<String>,
    status: &str,
    expires_at: Option<String>,
) -> LicenseInfo {
    LicenseInfo {
        application: app.into(),
        product,
        description: Some(description),
        channel: channel.map(Into::into),
        partial_key: key,
        status: status.into(),
        status_code: 0,
        expires_at,
    }
}

fn installed(items: &[Item], pred: impl Fn(&str) -> bool) -> Option<&Item> {
    items.iter().find(|i| pred(&i.name.to_lowercase()))
}

// ---------- nanoCAD ----------

pub fn nanocad(items: &[Item], roots: &Roots) -> Vec<LicenseInfo> {
    let Some(item) = installed(items, |n| {
        n.contains("nanocad") && !n.contains("license server") && !n.contains("сервер лицензий")
    }) else {
        return vec![];
    };
    let product = format!(
        "{}{}",
        item.name,
        item.version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default()
    );
    let base = Path::new(&roots.program_data).join("Nanosoft");
    let mut out = Vec::new();
    for (dir, how) in [
        (base.join("RegWizard").join("Licenses"), "RegWizard"),
        (base.join("License Manager").join("Licenses"), "License Manager"),
    ] {
        for f in files(&dir, "lic") {
            out.push(lic(
                NANOCAD,
                product.clone(),
                format!(
                    "локальная лицензия ({how}), файл {}",
                    f.file_name().unwrap_or_default().to_string_lossy()
                ),
                Some("Локальная"),
                tail5(&stem(&f)),
                "licensed",
                None,
            ));
        }
    }
    if out.is_empty() {
        out.push(lic(
            NANOCAD,
            product,
            "локальных файлов лицензии нет — вероятно, сетевая лицензия (сервер лицензий Нанософт)".into(),
            Some("Сетевая?"),
            None,
            "unknown",
            None,
        ));
    }
    out
}

// ---------- 1С:Предприятие ----------

pub fn onec(items: &[Item], roots: &Roots) -> Vec<LicenseInfo> {
    let Some(item) = installed(items, |n| {
        (n.starts_with("1c:предприятие") || n.starts_with("1с:предприятие") || n.starts_with("1c:enterprise"))
            && !n.contains("license tools")
    }) else {
        return vec![];
    };
    let product = format!(
        "1С:Предприятие{}",
        item.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default()
    );
    let dir = Path::new(&roots.program_data).join("1C").join("licenses");
    let found: Vec<LicenseInfo> =
        files(&dir, "lic")
            .iter()
            .map(|f| {
                lic(ONEC, product.clone(),
        "программная лицензия (файл в ProgramData\\1C\\licenses); комплект и число мест — ring license info".into(),
        Some("Программная"), tail5(&stem(f)), "licensed", None)
            })
            .collect();
    if found.is_empty() {
        return vec![lic(
            ONEC,
            product,
            "программных лицензий на ПК нет — сервер лицензий или аппаратный ключ HASP".into(),
            Some("Сервер/HASP?"),
            None,
            "unknown",
            None,
        )];
    }
    found
}

// ---------- Dr.Web ----------

/// Разбор ключевого файла Dr.Web (INI). Expires= «2026-11-12 (11:15) UTC» или «08-04-2026 (17:54)».
pub fn parse_drweb_key(text: &str, file_stem: &str, version: Option<&str>, now: u64) -> LicenseInfo {
    let get = |k: &str| {
        text.lines().find_map(|l| {
            let (a, b) = l.split_once('=')?;
            a.trim().eq_ignore_ascii_case(k).then(|| b.trim().to_string())
        })
    };
    let expires_at = get("Expires").and_then(|e| {
        let d = e.split_whitespace().next()?.to_string();
        let p: Vec<&str> = d.split('-').collect();
        let iso = match p.as_slice() {
            [y, m, d] if y.len() == 4 => format!("{y}-{m}-{d}"),
            [d, m, y] if y.len() == 4 => format!("{y}-{m}-{d}"),
            _ => return None,
        };
        Some(format!("{iso} 23:59:59"))
    });
    let past = expires_at
        .as_deref()
        .is_some_and(|d| d < crate::log::fmt_utc(now).as_str());
    let number = get("Number").or_else(|| get("SerialNumber"));
    let apps = get("Applications").map(|a| a.split(',').count()).unwrap_or(0);
    let product = format!("Dr.Web{}", version.map(|v| format!(" {v}")).unwrap_or_default());
    lic(
        DRWEB,
        product,
        format!(
            "ключевой файл {file_stem}.key{}",
            if apps > 0 {
                format!(", компонентов: {apps}")
            } else {
                String::new()
            }
        ),
        Some(if file_stem.eq_ignore_ascii_case("agent") {
            "Корпоративная (агент ES)"
        } else {
            "Ключевой файл"
        }),
        number.as_deref().and_then(tail5).or_else(|| tail5(file_stem)),
        if past {
            "expired"
        } else if expires_at.is_some() || number.is_some() {
            "licensed"
        } else {
            "unknown"
        },
        expires_at,
    )
}

pub fn drweb(items: &[Item], now: u64) -> Vec<LicenseInfo> {
    let Some(item) = installed(items, |n| n.contains("dr.web") && !n.contains("cureit")) else {
        return vec![];
    };
    let Some(loc) = item.install_location.as_deref() else {
        return vec![lic(
            DRWEB,
            item.name.clone(),
            "папка установки не указана в реестре — ключ не найден".into(),
            None,
            None,
            "unknown",
            None,
        )];
    };
    let keys = files(Path::new(loc), "key");
    if keys.is_empty() {
        return vec![lic(
            DRWEB,
            item.name.clone(),
            "ключевого файла в папке установки нет — лицензию выдаёт сервер Dr.Web ES".into(),
            Some("Сервер ES?"),
            None,
            "unknown",
            None,
        )];
    }
    keys.iter()
        .filter_map(|f| {
            let text =
                String::from_utf8_lossy(&std::fs::read(f).ok()?.into_iter().take(64 * 1024).collect::<Vec<u8>>())
                    .to_string();
            Some(parse_drweb_key(&text, &stem(f), item.version.as_deref(), now))
        })
        .collect()
}

/// Все файловые лицензии для снимка.
pub fn collect(items: &[Item], now: u64) -> Vec<LicenseInfo> {
    let roots = Roots::system();
    let mut v = nanocad(items, &roots);
    v.extend(onec(items, &roots));
    v.extend(drweb(items, now));
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: u64 = 1_763_078_400; // 2025-11-14

    fn it(n: &str, loc: Option<&str>) -> Item {
        Item {
            name: n.into(),
            publisher: None,
            version: Some("23.1".into()),
            install_date: None,
            install_location: loc.map(Into::into),
        }
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sam-licfiles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn nanocad_local_and_network() {
        let pd = tmp("nano");
        let roots = Roots {
            program_data: pd.display().to_string(),
        };
        let items = [it("nanoCAD x64 Plus 20.1", None)];
        let n = nanocad(&items, &roots);
        assert_eq!((n.len(), n[0].status.as_str()), (1, "unknown"), "нет файлов → сетевая?");
        let dir = pd.join("Nanosoft").join("RegWizard").join("Licenses");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("NC-8KQ2T.lic"), b"\x01\x02").unwrap();
        std::fs::write(dir.join("readme.txt"), b"x").unwrap();
        let n = nanocad(&items, &roots);
        assert_eq!(
            (n.len(), n[0].status.as_str(), n[0].partial_key.as_deref()),
            (1, "licensed", Some("8KQ2T"))
        );
        assert!(nanocad(&[it("Nanosoft NormaCS 4.x Lite Клиент", None)], &roots).is_empty());
        let _ = std::fs::remove_dir_all(pd);
    }

    #[test]
    fn onec_files() {
        let pd = tmp("onec");
        let roots = Roots {
            program_data: pd.display().to_string(),
        };
        assert!(onec(&[it("Яндекс Браузер", None)], &roots).is_empty());
        let items = [it("1C:Предприятие 8 (8.3.24.1548)", None)];
        assert_eq!(onec(&items, &roots)[0].status, "unknown");
        let dir = pd.join("1C").join("licenses");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("20210114170512.lic"), b"x").unwrap();
        std::fs::write(dir.join("20230301094422.lic"), b"x").unwrap();
        let l = onec(&items, &roots);
        assert_eq!(
            (l.len(), l[0].partial_key.as_deref(), l[1].partial_key.as_deref()),
            (2, Some("70512"), Some("94422"))
        );
        let _ = std::fs::remove_dir_all(pd);
    }

    #[test]
    fn drweb_key_file() {
        let key = "; Dr.Web Key File\n[Key]\nNumber=0123456789\nApplications=DrWebWCL, SpIDerGuard, DrWebUpdate\nCreated=2025-01-10 (10:00) UTC\nExpires=2026-01-10 (10:00) UTC\n[User]\nName=ПАО\n";
        let l = parse_drweb_key(key, "agent", Some("12.0"), NOW);
        assert_eq!(
            (l.status.as_str(), l.expires_at.as_deref(), l.partial_key.as_deref()),
            ("licensed", Some("2026-01-10 23:59:59"), Some("56789"))
        );
        assert_eq!(l.channel.as_deref(), Some("Корпоративная (агент ES)"));
        let old = parse_drweb_key("[Key]\nExpires=08-04-2024 (17:54)\n", "SL123456789", None, NOW);
        assert_eq!(
            (old.status.as_str(), old.partial_key.as_deref()),
            ("expired", Some("56789"))
        );

        let dir = tmp("drweb");
        std::fs::write(dir.join("drweb32.key"), key).unwrap();
        let v = drweb(&[it("Dr.Web Security Space", Some(&dir.display().to_string()))], NOW);
        assert_eq!((v.len(), v[0].status.as_str()), (1, "licensed"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
