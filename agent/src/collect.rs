//! Сбор данных об устройстве и установленном ПО.
//! Windows: реестр Uninstall — HKLM (64- и 32-битное представление) + HKEY_USERS\<SID> для всех
//! загруженных профилей (служба работает под LocalSystem, её HKCU — это не пользователи!).
//! Серийник — из SMBIOS (smbios.rs), при мусоре/отсутствии — `GUID-<MachineGuid>`.
//! Ограничение: профили пользователей, которые сейчас не вошли в систему, не загружены и не видны.
//! Прочие ОС: только режим --fake. Чистые хелперы (серийник, имя ОС, дедуп) тестируются на любой ОС.
#![cfg_attr(not(windows), allow(dead_code))] // часть функций вызывается только в Windows-сборке
use crate::model::{Device, Item};

/// Мусорные серийники BIOS сборных ПК и ВМ → нужен запасной идентификатор.
pub fn is_bad_serial(s: &str) -> bool {
    let t = s.trim().to_ascii_lowercase();
    t.len() < 3
        || t.chars().all(|c| c == '0' || c == ' ')
        || [
            "to be filled by o.e.m.",
            "default string",
            "system serial number",
            "none",
            "not specified",
            "not applicable",
            "chassis serial number",
            "123456789",
            "o.e.m.",
        ]
        .contains(&t.as_str())
}

/// Windows 11 в реестре до сих пор пишет ProductName «Windows 10 …»; отличаем по номеру сборки.
pub fn fix_os_name(product: &str, build: Option<u32>) -> String {
    match build {
        Some(b) if b >= 22_000 && product.contains("Windows 10") => product.replacen("Windows 10", "Windows 11", 1),
        _ => product.to_string(),
    }
}

/// Одна программа часто записана и в 64-, и в 32-битной ветке: убираем точные дубли, порядок сохраняем.
pub fn dedupe(items: Vec<Item>) -> Vec<Item> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|i| seen.insert((i.name.clone(), i.publisher.clone(), i.version.clone())))
        .collect()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::*;
    use winreg::RegKey;

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    fn read_uninstall(root: &RegKey, path: &str, flags: u32, out: &mut Vec<Item>) {
        let Ok(key) = root.open_subkey_with_flags(path, KEY_READ | flags) else {
            return;
        };
        for sub in key.enum_keys().flatten() {
            let Ok(sk) = key.open_subkey_with_flags(&sub, KEY_READ | flags) else {
                continue;
            };
            let Ok(name) = sk.get_value::<String, _>("DisplayName") else {
                continue;
            };
            let name = name.trim().to_string();
            if name.is_empty() || sk.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 {
                continue;
            }
            // обновления Windows/Office (KB…) с ParentKeyName — компоненты, а не продукты
            if sk.get_value::<String, _>("ParentKeyName").is_ok() {
                continue;
            }
            let opt = |v: &str| {
                sk.get_value::<String, _>(v)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            let location = opt("InstallLocation")
                .map(|l| l.trim_matches('"').to_string())
                .filter(|l| l.len() > 3);
            out.push(Item {
                name,
                publisher: opt("Publisher"),
                version: opt("DisplayVersion"),
                install_date: opt("InstallDate"),
                install_location: location,
            });
        }
    }

    pub fn items() -> Result<Vec<Item>, String> {
        let mut v = Vec::new();
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        read_uninstall(&hklm, UNINSTALL, KEY_WOW64_64KEY, &mut v);
        read_uninstall(&hklm, UNINSTALL, KEY_WOW64_32KEY, &mut v);
        let hku = RegKey::predef(HKEY_USERS);
        for sid in hku.enum_keys().flatten() {
            if sid.ends_with("_Classes") {
                continue;
            }
            read_uninstall(&hku, &format!(r"{sid}\{UNINSTALL}"), 0, &mut v);
        }
        Ok(dedupe(v))
    }

    pub fn device() -> Result<Device, String> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        // серийник BIOS — из SMBIOS (в реестре его нет); формат как в выгрузке организаторов
        let serial = if let Some(sn) = crate::smbios::read_raw()
            .as_deref()
            .and_then(crate::smbios::serial_from_raw)
        {
            sn
        } else {
            // запасной вариант: MachineGuid (уникален для установки Windows)
            let guid = hklm
                .open_subkey_with_flags(r"SOFTWARE\Microsoft\Cryptography", KEY_READ | KEY_WOW64_64KEY)
                .and_then(|k| k.get_value::<String, _>("MachineGuid"))
                .map_err(|e| format!("нет ни серийного номера BIOS, ни MachineGuid: {e}"))?;
            format!("GUID-{}", guid.trim())
        };
        let cv = hklm
            .open_subkey_with_flags(
                r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                KEY_READ | KEY_WOW64_64KEY,
            )
            .ok();
        let product = cv.as_ref().and_then(|k| k.get_value::<String, _>("ProductName").ok());
        let build = cv
            .as_ref()
            .and_then(|k| k.get_value::<String, _>("CurrentBuild").ok())
            .and_then(|b| b.parse().ok());
        Ok(Device {
            serial_number: serial,
            hostname: std::env::var("COMPUTERNAME").ok(),
            os: product.map(|p| fix_os_name(&p, build)),
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    const MSG: &str = "реальный сбор поддерживается только на Windows; используйте --fake <файл.json>";
    pub fn items() -> Result<Vec<Item>, String> {
        Err(MSG.into())
    }
    pub fn device() -> Result<Device, String> {
        Err(MSG.into())
    }
}

pub use imp::{device, items};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_serials() {
        for s in [
            "To be filled by O.E.M.",
            "Default string",
            "0",
            "000000000",
            "  ",
            "System Serial Number",
        ] {
            assert!(is_bad_serial(s), "{s}");
        }
        for s in [
            "B1RG0S2",
            "VMware-42 37 a3 72 7d 0d 31 e6-6e 82 cf e4 99 ef 41 d1",
            "CZC5021471",
        ] {
            assert!(!is_bad_serial(s), "{s}");
        }
    }

    #[test]
    fn windows_11_detected_by_build() {
        assert_eq!(fix_os_name("Windows 10 Pro", Some(22631)), "Windows 11 Pro");
        assert_eq!(fix_os_name("Windows 10 Pro", Some(19045)), "Windows 10 Pro");
        assert_eq!(
            fix_os_name("Windows Server 2019 Standard", Some(17763)),
            "Windows Server 2019 Standard"
        );
    }

    #[test]
    fn dedupe_keeps_order_and_versions() {
        let it = |n: &str, v: &str| Item {
            name: n.into(),
            publisher: None,
            version: Some(v.into()),
            install_date: None,
            install_location: None,
        };
        let out = dedupe(vec![it("a", "1"), it("b", "1"), it("a", "1"), it("a", "2")]);
        assert_eq!(
            out.iter()
                .map(|i| (i.name.as_str(), i.version.as_deref().unwrap()))
                .collect::<Vec<_>>(),
            [("a", "1"), ("b", "1"), ("a", "2")]
        );
    }
}
