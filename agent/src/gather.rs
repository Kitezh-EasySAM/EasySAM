//! Что агент видит на ПК: программы, лицензии, процессы — с машины или из файла --fake (проверка логики на Linux).
use crate::model::{Device, FakeInput, Item};
use crate::{collect, cryptopro, kaspersky, licenses, licfiles, now, process};

pub fn gather(fake: &Option<String>) -> Result<(Device, Vec<Item>), String> {
    if let Some(path) = fake {
        let f = read_fake(path)?;
        return Ok((f.device, collect::dedupe(f.items)));
    }
    Ok((collect::device()?, collect::items()?))
}

pub fn read_fake(path: &str) -> Result<FakeInput, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

/// В режиме --fake «установленный» ключ КриптоПро (эмуляция cpconfig -license -set для проверки цепочки на Linux).
pub static FAKE_CP_KEY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Лицензии Windows/Office (WMI, медленно) и российского ПО (КриптоПро, KES, nanoCAD, 1С, Dr.Web) — только для полного снимка.
pub fn gather_licenses(fake: &Option<String>, items: &[Item]) -> Vec<licenses::LicenseInfo> {
    match fake {
        Some(path) => {
            let mut l = read_fake(path).map(|f| f.licenses).unwrap_or_default();
            if let Some(key) = FAKE_CP_KEY.lock().ok().and_then(|k| k.clone()) {
                l.retain(|x| x.application != cryptopro::PRODUCT);
                l.push(cryptopro::parse_license(
                    &format!("Серийный номер: {key}\nСрок действия: 365 дней\nТип лицензии: Клиентская"),
                    Some("5.0.12000"),
                    now(),
                ));
            }
            l
        }
        None => {
            let mut l = licenses::collect();
            l.extend(cryptopro::collect(items, now()));
            l.extend(kaspersky::collect(items, now()));
            l.extend(licfiles::collect(items, now()));
            l
        }
    }
}

pub fn gather_processes(fake: &Option<String>) -> Vec<process::RawProc> {
    match fake {
        Some(path) => read_fake(path).map(|f| f.processes).unwrap_or_default(),
        None => process::running(),
    }
}
