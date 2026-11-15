//! Лицензии Windows и Office из службы защиты ПО (SPP) через WMI.
//!   Windows / Office 2013+: root\cimv2 SoftwareLicensingProduct; Office 2010: OfficeSoftwareProtectionProduct.
//! Берём только строки с установленным ключом (PartialProductKey IS NOT NULL).
//! ПОЛНЫЙ КЛЮЧ НЕ СОБИРАЕМ И НЕ ОТПРАВЛЯЕМ: только последние 5 символов (их и отдаёт SPP) — этого хватает,
//! чтобы сервер нашёл один Retail-ключ на нескольких ПК, и это не утечка секрета.
//! Срок: GracePeriodRemaining (минуты до конца льготного периода / повторной KMS-активации) и EvaluationEndDate.
//! WMI медленный (секунды) — вызывается только при полном снимке (старт и раз в сутки). Разбор строк тестируется на любой ОС.
#![cfg_attr(not(windows), allow(dead_code))]
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub application: String,         // windows | office | other
    pub product: String, // «Windows(R), Professional edition», «Office 16, Office16StandardVL_KMS_Client edition»
    pub description: Option<String>, // «Windows(R) Operating System, RETAIL channel»
    pub channel: Option<String>, // Retail | OEM | Volume:MAK | Volume:GVLK | Subscription | …
    pub partial_key: Option<String>, // последние 5 символов ключа
    pub status: String,  // licensed | grace | notification | unlicensed | unknown
    pub status_code: u32, // сырой LicenseStatus (0..6)
    pub expires_at: Option<String>, // UTC «YYYY-MM-DD HH:MM:SS»: конец льготного периода / ознакомительной версии
}

/// Сырая строка WMI (поля одинаковые у обоих классов; ProductKeyChannel есть только у SoftwareLicensingProduct).
#[derive(Debug, Default, Deserialize)]
pub struct SppRow {
    #[serde(rename = "Name")]
    pub name: Option<String>,
    #[serde(rename = "Description")]
    pub description: Option<String>,
    #[serde(rename = "ApplicationID")]
    pub application_id: Option<String>,
    #[serde(rename = "LicenseStatus")]
    pub license_status: Option<u32>,
    #[serde(rename = "GracePeriodRemaining")]
    pub grace_minutes: Option<u32>,
    #[serde(rename = "PartialProductKey")]
    pub partial_key: Option<String>,
    #[serde(rename = "ProductKeyChannel", default)]
    pub channel: Option<String>,
    #[serde(rename = "EvaluationEndDate", default)]
    pub evaluation_end: Option<String>,
}

const WINDOWS_APP: &str = "55c92734-d682-4d71-983e-d6ec3f16059f";
const OFFICE_APPS: [&str; 2] = [
    "0ff1ce15-a989-479d-af46-f275c6370663",
    "59a52881-a989-479d-af46-f275c6370663",
];

pub fn status_name(code: u32) -> &'static str {
    match code {
        0 => "unlicensed",
        1 => "licensed",
        2 | 3 | 4 | 6 => "grace", // OOB / OOT / NonGenuine / Extended grace
        5 => "notification",      // режим уведомлений: не активирована или не подлинная
        _ => "unknown",
    }
}

/// Канал из ProductKeyChannel, иначе из описания «…, VOLUME_KMSCLIENT channel».
pub fn channel_of(channel: Option<&str>, description: Option<&str>) -> Option<String> {
    if let Some(c) = channel.map(str::trim).filter(|c| !c.is_empty()) {
        return Some(c.to_string());
    }
    let d = description?.to_ascii_uppercase();
    let c = if d.contains("VOLUME_KMSCLIENT") {
        "Volume:GVLK"
    } else if d.contains("VOLUME_MAK") {
        "Volume:MAK"
    } else if d.contains("KMS") {
        "Volume:KMS"
    } else if d.contains("OEM") {
        "OEM"
    } else if d.contains("RETAIL") {
        "Retail"
    } else if d.contains("TIMEBASED") || d.contains("SUBSCRIPTION") {
        "Subscription"
    } else {
        return None;
    };
    Some(c.to_string())
}

/// CIM_DATETIME «20261231000000.000000+000» → секунды UTC (смещение пояса игнорируем: точность до дня достаточна).
/// «Нулевые»/бесконечные даты (1601, 9999) → None.
pub fn parse_cim_datetime(s: &str) -> Option<u64> {
    let d = s.get(0..14)?;
    if !d.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = |a: usize, b: usize| d[a..b].parse::<i64>().ok();
    let (y, mo, da, h, mi, se) = (n(0, 4)?, n(4, 6)?, n(6, 8)?, n(8, 10)?, n(10, 12)?, n(12, 14)?);
    if !(2000..=9000).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    // days_from_civil (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + se).ok()
}

pub fn from_row(r: &SppRow, now: u64) -> LicenseInfo {
    let app_id = r.application_id.as_deref().unwrap_or("").to_ascii_lowercase();
    let application = if app_id == WINDOWS_APP {
        "windows"
    } else if OFFICE_APPS.contains(&app_id.as_str()) {
        "office"
    } else {
        "other"
    };
    let code = r.license_status.unwrap_or(u32::MAX);
    let grace_end = r.grace_minutes.filter(|m| *m > 0).map(|m| now + u64::from(m) * 60);
    let eval_end = r.evaluation_end.as_deref().and_then(parse_cim_datetime);
    let expires = match (grace_end, eval_end) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    LicenseInfo {
        application: application.into(),
        product: r.name.clone().unwrap_or_else(|| "?".into()),
        description: r.description.clone(),
        channel: channel_of(r.channel.as_deref(), r.description.as_deref()),
        partial_key: r.partial_key.clone().filter(|k| !k.trim().is_empty()),
        status: status_name(code).into(),
        status_code: if code == u32::MAX { 99 } else { code },
        expires_at: expires.map(crate::log::fmt_utc),
    }
}

#[cfg(windows)]
pub fn collect() -> Vec<LicenseInfo> {
    use wmi::{COMLibrary, WMIConnection};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let wmi = match COMLibrary::new().and_then(WMIConnection::new) {
        Ok(w) => w,
        Err(e) => {
            crate::log::error(&format!("WMI недоступен, лицензии не собраны: {e}"));
            return vec![];
        }
    };
    let mut out = Vec::new();
    for (class, cols) in [
        ("SoftwareLicensingProduct", "Name, Description, ApplicationID, LicenseStatus, GracePeriodRemaining, PartialProductKey, ProductKeyChannel, EvaluationEndDate"),
        ("OfficeSoftwareProtectionProduct", "Name, Description, ApplicationID, LicenseStatus, GracePeriodRemaining, PartialProductKey, EvaluationEndDate"),
    ] {
        match wmi.raw_query::<SppRow>(format!("SELECT {cols} FROM {class} WHERE PartialProductKey IS NOT NULL")) {
            Ok(rows) => out.extend(rows.iter().map(|r| from_row(r, now))),
            // OfficeSoftwareProtectionProduct есть только при установленном Office 2010 — отсутствие не ошибка
            Err(e) if class == "SoftwareLicensingProduct" => crate::log::error(&format!("WMI {class}: {e}")),
            Err(_) => {}
        }
    }
    out
}

#[cfg(not(windows))]
pub fn collect() -> Vec<LicenseInfo> {
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_and_channels() {
        assert_eq!(status_name(1), "licensed");
        assert_eq!(status_name(5), "notification");
        assert_eq!(status_name(0), "unlicensed");
        assert_eq!(status_name(2), "grace");
        assert_eq!(channel_of(Some("OEM:DM"), None).as_deref(), Some("OEM:DM"));
        assert_eq!(
            channel_of(None, Some("Windows(R) Operating System, VOLUME_KMSCLIENT channel")).as_deref(),
            Some("Volume:GVLK")
        );
        assert_eq!(
            channel_of(Some(" "), Some("Office 16, RETAIL channel")).as_deref(),
            Some("Retail")
        );
        assert_eq!(channel_of(None, Some("что-то")), None);
    }

    #[test]
    fn cim_dates() {
        assert_eq!(parse_cim_datetime("20231114221320.000000+000"), Some(1_700_000_000));
        assert_eq!(parse_cim_datetime("16010101000000.000000-000"), None);
        assert_eq!(parse_cim_datetime("99991231235959.000000+000"), None);
        assert_eq!(parse_cim_datetime("мусор"), None);
    }

    #[test]
    fn windows_kms_row_gets_expiry_from_grace() {
        let r = SppRow {
            name: Some("Windows(R), Professional edition".into()),
            description: Some("Windows(R) Operating System, VOLUME_KMSCLIENT channel".into()),
            application_id: Some("55C92734-D682-4D71-983E-D6EC3F16059F".into()),
            license_status: Some(1),
            grace_minutes: Some(259_200), // 180 дней
            partial_key: Some("T83GX".into()),
            ..Default::default()
        };
        let l = from_row(&r, 1_700_000_000);
        assert_eq!(
            (l.application.as_str(), l.status.as_str(), l.channel.as_deref()),
            ("windows", "licensed", Some("Volume:GVLK"))
        );
        assert_eq!(l.expires_at.as_deref(), Some("2024-05-12 22:13:20"));
        assert_eq!(l.partial_key.as_deref(), Some("T83GX"));
    }

    #[test]
    fn evaluation_end_and_unlicensed_office() {
        let r = SppRow {
            name: Some("Office 16, Office16ProPlusR_Trial edition".into()),
            application_id: Some("0ff1ce15-a989-479d-af46-f275c6370663".into()),
            license_status: Some(5),
            evaluation_end: Some("20231231000000.000000+000".into()),
            partial_key: Some(" ".into()),
            ..Default::default()
        };
        let l = from_row(&r, 1_700_000_000);
        assert_eq!(
            (l.application.as_str(), l.status.as_str(), l.status_code),
            ("office", "notification", 5)
        );
        assert_eq!(l.expires_at.as_deref(), Some("2023-12-31 00:00:00"));
        assert_eq!(l.partial_key, None);
        assert_eq!(from_row(&SppRow::default(), 0).status, "unknown");
    }
}
