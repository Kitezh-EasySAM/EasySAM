//! Типы данных агента. Контракт с сервером: docs/API.md (поля совпадают с zod-схемами server/src/routes/ingest.ts).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub name: String,
    pub publisher: Option<String>,
    pub version: Option<String>,
    pub install_date: Option<String>,
    /// Папка установки (реестр InstallLocation) — сервер по ней связывает процессы с программой.
    #[serde(default)]
    pub install_location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub serial_number: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventType {
    Installed,
    Removed,
    Updated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: EventType,
    pub name: String,
    pub publisher: Option<String>,
    pub old_version: Option<String>,
    pub new_version: Option<String>,
}

/// Файл для режима --fake (отладка на не-Windows и симулятор): устройство + список ПО.
#[derive(Debug, Deserialize)]
pub struct FakeInput {
    #[serde(flatten)]
    pub device: Device,
    pub items: Vec<Item>,
    #[serde(default)]
    pub licenses: Vec<crate::licenses::LicenseInfo>,
    #[serde(default)]
    pub processes: Vec<crate::process::RawProc>,
}
