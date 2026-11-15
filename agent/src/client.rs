//! HTTP-клиент: POST JSON на сервер с токеном. Контракт: docs/API.md §6.
//! HTTPS через системный TLS (native-tls): на Windows — SChannel и доверенные сертификаты Windows.
use crate::licenses::LicenseInfo;
use crate::model::{Device, Event, Item};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// Сервер не знает ПК (база пересоздана): надо сбросить состояние и отправить полный снимок.
pub const NEED_SNAPSHOT: &str = "сервер не знает этот ПК: нужен полный снимок";

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Command {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub product: String,
    /// ключ лицензии — только у set_license
    pub key: Option<String>,
}

/// Процентное кодирование для query (в серийниках VMware есть пробелы).
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Токен ПК отозван или неизвестен серверу — нужна повторная регистрация по ключу.
pub const NEED_ENROLL: &str = "токен ПК не принят сервером: нужна повторная регистрация";

pub struct Client {
    server: String,
    /// общий токен (X-Ingest-Token), если нет собственного
    token: String,
    /// собственный токен ПК (X-Agent-Token) — после регистрации
    device_token: std::cell::RefCell<Option<String>>,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(server: &str, token: &str) -> Self {
        let mut b = ureq::AgentBuilder::new().timeout(Duration::from_secs(30));
        if let Ok(tls) = native_tls::TlsConnector::new() {
            b = b.tls_connector(Arc::new(tls));
        }
        Client {
            server: server.trim_end_matches('/').to_string(),
            token: token.to_string(),
            device_token: Default::default(),
            agent: b.build(),
        }
    }

    pub fn set_device_token(&self, t: Option<String>) {
        *self.device_token.borrow_mut() = t;
    }
    pub fn has_device_token(&self) -> bool {
        self.device_token.borrow().is_some()
    }

    /// Токен ПК, если есть, иначе общий.
    fn auth(&self, req: ureq::Request) -> ureq::Request {
        match self.device_token.borrow().as_deref() {
            Some(t) => req.set("X-Agent-Token", t),
            None => req.set("X-Ingest-Token", &self.token),
        }
    }

    fn err(&self, path: &str, e: ureq::Error) -> String {
        match e {
            ureq::Error::Status(409, _) if path.ends_with("/events") || path.ends_with("/usage") => {
                NEED_SNAPSHOT.into()
            }
            ureq::Error::Status(401, r) => {
                let body = r.into_string().unwrap_or_default();
                if body.contains("\"reenroll\":true") {
                    NEED_ENROLL.into()
                } else {
                    format!("сервер ответил 401: {body}")
                }
            }
            ureq::Error::Status(code, r) => format!("сервер ответил {code}: {}", r.into_string().unwrap_or_default()),
            e => format!("нет связи с {}: {e}", self.server),
        }
    }

    fn post(&self, path: &str, body: serde_json::Value) -> Result<(), String> {
        self.auth(self.agent.post(&format!("{}{}", self.server, path)))
            .send_json(body)
            .map(|_| ())
            .map_err(|e| self.err(path, e))
    }

    /// Регистрация ПК по ключу → собственный токен.
    pub fn enroll(&self, enroll_key: &str, dev: &Device) -> Result<String, String> {
        #[derive(serde::Deserialize)]
        struct R {
            token: String,
        }
        self.agent.post(&format!("{}/api/agent/enroll", self.server))
            .send_json(json!({ "enroll_key": enroll_key, "serial_number": dev.serial_number, "hostname": dev.hostname, "os": dev.os }))
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => format!("регистрация: сервер ответил {code}: {}", r.into_string().unwrap_or_default()),
                e => format!("регистрация: нет связи с {}: {e}", self.server),
            })?
            .into_json::<R>().map(|r| r.token).map_err(|e| format!("регистрация: {e}"))
    }

    pub fn snapshot(&self, dev: &Device, items: &[Item], licenses: &[LicenseInfo]) -> Result<(), String> {
        self.post("/api/ingest/agent", json!({
            "serial_number": dev.serial_number, "hostname": dev.hostname, "os": dev.os, "items": items, "licenses": licenses }))
    }

    /// Задания для ПК (сейчас только set_license). Ключ приходит только этим каналом.
    pub fn commands(&self, serial: &str) -> Result<Vec<Command>, String> {
        let url = format!("{}/api/agent/commands?serial={}", self.server, encode(serial));
        match self.auth(self.agent.get(&url)).call() {
            Ok(r) => r.into_json::<Vec<Command>>().map_err(|e| format!("команды: {e}")),
            Err(e) => Err(self.err("/api/agent/commands", e)),
        }
    }

    pub fn command_result(&self, id: i64, serial: &str, ok: bool, output: &str) -> Result<(), String> {
        let out: String = output.chars().take(4000).collect();
        self.post(
            &format!("/api/agent/commands/{id}/result"),
            json!({ "serial_number": serial, "ok": ok, "output": out }),
        )
    }

    pub fn usage(&self, dev: &Device, processes: &[crate::process::ProcUsage]) -> Result<(), String> {
        self.post(
            "/api/ingest/usage",
            json!({
            "serial_number": dev.serial_number, "hostname": dev.hostname, "os": dev.os, "processes": processes }),
        )
    }

    pub fn events(&self, dev: &Device, events: &[Event]) -> Result<(), String> {
        self.post(
            "/api/ingest/events",
            json!({
            "serial_number": dev.serial_number, "hostname": dev.hostname, "os": dev.os, "events": events }),
        )
    }
}
