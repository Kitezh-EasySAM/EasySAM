//! Запущенные процессы → сводка использования для сервера (POST /api/ingest/usage).
//! Каждый цикл агент снимает список процессов (ToolHelp32 + полный путь exe), отбрасывает системные
//! (%SystemRoot%, Защитник, встроенные приложения), копит first_seen/last_seen/samples по пути exe
//! и раз в usage_interval отправляет. Из exe читается VERSIONINFO (ProductName, CompanyName, версия):
//! так chrome.exe превращается в «Google Chrome» — «грязное» имя процесса чистится ещё на ПК.
//! Сопоставление с каталогом и выводы (last_used, неустановленное ПО, алерты) — на сервере.
#![cfg_attr(not(windows), allow(dead_code))]
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerInfo {
    pub product_name: Option<String>,
    pub company: Option<String>,
    pub file_version: Option<String>,
}

/// Процесс как он есть в системе (для --fake можно сразу указать сведения exe).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawProc {
    pub exe: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(flatten, default)]
    pub ver: Option<VerInfo>,
}

/// Строка отчёта для сервера.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProcUsage {
    pub exe: String,
    pub path: Option<String>,
    pub product_name: Option<String>,
    pub company: Option<String>,
    pub file_version: Option<String>,
    pub first_seen: String, // ISO UTC
    pub last_seen: String,
    pub samples: u32,
}

const SKIP_EXE: &[&str] = &[
    "system",
    "registry",
    "idle",
    "[system process]",
    "memory compression",
    "secure system",
    "sam-agent.exe",
    "msmpeng.exe",
    "nissrv.exe",
    "mpdefendercoreservice.exe",
    "smartscreen.exe",
    "securityhealthservice.exe",
];

/// Системные и служебные процессы, которые не являются «программами пользователя».
pub fn is_system(exe: &str, path: Option<&str>, system_root: &str) -> bool {
    if SKIP_EXE.contains(&exe.to_ascii_lowercase().as_str()) {
        return true;
    }
    let Some(p) = path else { return false };
    let p = p.replace('/', "\\").to_ascii_lowercase();
    let root = system_root.trim_end_matches('\\').to_ascii_lowercase();
    (!root.is_empty() && p.starts_with(&format!("{root}\\")))
        || p.contains("\\windows defender")
        || p.contains("\\windowsapps\\microsoft.") // встроенные приложения магазина (калькулятор, фото…)
        || p.contains("\\microsoft\\edgeupdate\\")
        || p.contains("\\microsoft\\edgewebview\\") // среда WebView2, не программа
}

pub fn iso(secs: u64) -> String {
    format!("{}Z", crate::log::fmt_utc(secs).replace(' ', "T"))
}

struct Entry {
    exe: String,
    path: Option<String>,
    ver: VerInfo,
    first: u64,
    last: u64,
    samples: u32,
}

/// Копит наблюдения между отправками; кеширует VERSIONINFO по пути (читать файл каждый цикл незачем).
#[derive(Default)]
pub struct Tracker {
    map: HashMap<String, Entry>,
    ver_cache: HashMap<String, VerInfo>,
    pub last_sent: u64,
    /// была ли уже успешная отправка: первую сводку шлём быстро (≤ 60 с), дальше — по usage_interval
    pub sent_once: bool,
}

impl Tracker {
    pub fn observe(&mut self, procs: Vec<RawProc>, now: u64, system_root: &str, read_ver: &dyn Fn(&str) -> VerInfo) {
        let mut seen_now = std::collections::HashSet::new();
        for p in procs {
            // без пути: системные или чужие процессы (без прав администратора Windows путь не отдаёт)
            if p.path.is_none() || is_system(&p.exe, p.path.as_deref(), system_root) {
                continue;
            }
            let key = p.path.clone().unwrap_or_else(|| p.exe.clone()).to_ascii_lowercase();
            if !seen_now.insert(key.clone()) {
                continue; // несколько экземпляров (chrome.exe ×30) = одно наблюдение за цикл
            }
            let ver = match (&p.ver, &p.path) {
                (Some(v), _) => v.clone(),
                (None, Some(path)) => {
                    if self.ver_cache.len() > 5000 {
                        self.ver_cache.clear();
                    }
                    self.ver_cache
                        .entry(path.to_ascii_lowercase())
                        .or_insert_with(|| read_ver(path))
                        .clone()
                }
                (None, None) => VerInfo::default(),
            };
            let e = self.map.entry(key).or_insert(Entry {
                exe: p.exe.clone(),
                path: p.path.clone(),
                ver,
                first: now,
                last: now,
                samples: 0,
            });
            e.last = now;
            e.samples += 1;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn report(&self) -> Vec<ProcUsage> {
        let mut v: Vec<ProcUsage> = self
            .map
            .values()
            .map(|e| ProcUsage {
                exe: e.exe.clone(),
                path: e.path.clone(),
                product_name: e.ver.product_name.clone(),
                company: e.ver.company.clone(),
                file_version: e.ver.file_version.clone(),
                first_seen: iso(e.first),
                last_seen: iso(e.last),
                samples: e.samples,
            })
            .collect();
        v.sort_by_key(|a| a.exe.to_ascii_lowercase());
        v
    }

    /// После успешной отправки: начинаем новый интервал (кеш сведений exe сохраняем).
    pub fn clear(&mut self, now: u64) {
        self.map.clear();
        self.last_sent = now;
        self.sent_once = true;
    }

    /// Пора ли отправлять: первая сводка — через min(interval, 60) с после старта, дальше — раз в interval.
    pub fn due(&self, now: u64, interval: u64) -> bool {
        let wait = if self.sent_once { interval } else { interval.min(60) };
        now.saturating_sub(self.last_sent) >= wait
    }
}

pub fn system_root() -> String {
    // без переменной (служба со странным окружением, отладка --fake на Linux) считаем стандартный путь
    std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
pub fn running() -> Vec<RawProc> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut out = Vec::new();
    // SAFETY: стандартный обход ToolHelp32; все дескрипторы закрываются; буферы фиксированного размера.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            let exe = String::from_utf16_lossy(&e.szExeFile[..n]);
            let mut path = None;
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, e.th32ProcessID);
            if !h.is_null() {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0 {
                    path = Some(String::from_utf16_lossy(&buf[..len as usize]));
                }
                CloseHandle(h);
            }
            out.push(RawProc { exe, path, ver: None });
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}

/// VERSIONINFO exe: ProductName, CompanyName, ProductVersion/FileVersion (с учётом языка ресурса).
#[cfg(windows)]
pub fn version_info(path: &str) -> VerInfo {
    use std::ffi::c_void;
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    let wpath = wide(path);
    // SAFETY: буфер выделен по размеру из GetFileVersionInfoSizeW; VerQueryValueW возвращает указатели внутрь буфера,
    // которые читаются, пока буфер жив; длина строковых значений — в символах.
    unsafe {
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeW(wpath.as_ptr(), &mut handle);
        if size == 0 {
            return VerInfo::default();
        }
        let mut buf = vec![0u8; size as usize];
        if GetFileVersionInfoW(wpath.as_ptr(), 0, size, buf.as_mut_ptr().cast()) == 0 {
            return VerInfo::default();
        }
        let mut prefixes: Vec<String> = Vec::new();
        let mut p: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(
            buf.as_ptr().cast(),
            wide(r"\VarFileInfo\Translation").as_ptr(),
            &mut p,
            &mut len,
        ) != 0
            && len >= 4
            && !p.is_null()
        {
            let pairs = std::slice::from_raw_parts(p as *const u16, (len / 2) as usize);
            let (pairs, _) = pairs.as_chunks::<2>();
            for [lang, cp] in pairs {
                prefixes.push(format!("{lang:04x}{cp:04x}"));
            }
        }
        for d in ["040904b0", "040904e4", "041904b0", "000004b0"] {
            prefixes.push(d.into());
        }
        let get = |name: &str| -> Option<String> {
            for pre in &prefixes {
                let mut p: *mut c_void = std::ptr::null_mut();
                let mut len = 0u32;
                let key = wide(&format!(r"\StringFileInfo\{pre}\{name}"));
                if VerQueryValueW(buf.as_ptr().cast(), key.as_ptr(), &mut p, &mut len) != 0 && len > 0 && !p.is_null() {
                    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p as *const u16, len as usize));
                    let s = s.trim_end_matches('\0').trim().to_string();
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
            None
        };
        VerInfo {
            product_name: get("ProductName"),
            company: get("CompanyName"),
            file_version: get("ProductVersion").or_else(|| get("FileVersion")),
        }
    }
}

#[cfg(not(windows))]
pub fn running() -> Vec<RawProc> {
    vec![]
}
#[cfg(not(windows))]
pub fn version_info(_path: &str) -> VerInfo {
    VerInfo::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_filter() {
        let root = r"C:\Windows";
        assert!(is_system("svchost.exe", Some(r"C:\Windows\System32\svchost.exe"), root));
        assert!(is_system("explorer.exe", Some(r"c:\windows\explorer.exe"), root));
        assert!(is_system("System", None, root));
        assert!(is_system(
            "MsMpEng.exe",
            Some(r"C:\ProgramData\Microsoft\Windows Defender\Platform\MsMpEng.exe"),
            root
        ));
        assert!(is_system(
            "sam-agent.exe",
            Some(r"C:\Program Files\SAM\sam-agent.exe"),
            root
        ));
        assert!(!is_system(
            "chrome.exe",
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            root
        ));
        assert!(!is_system("WinRAR.exe", Some(r"C:\Users\u\Downloads\WinRAR.exe"), root));
        assert!(
            !is_system("app.exe", Some(r"C:\WindowsApps2\app.exe"), root),
            "похожий префикс — не системный"
        );
    }

    #[test]
    fn tracker_aggregates_and_caches_version() {
        let calls = std::cell::Cell::new(0);
        let read = |_: &str| {
            calls.set(calls.get() + 1);
            VerInfo {
                product_name: Some("Google Chrome".into()),
                company: Some("Google LLC".into()),
                file_version: Some("131".into()),
            }
        };
        let chrome = || RawProc {
            exe: "chrome.exe".into(),
            path: Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".into()),
            ver: None,
        };
        let mut t = Tracker::default();
        t.observe(vec![chrome(), chrome(), chrome()], 1_700_000_000, r"C:\Windows", &read); // 3 экземпляра = 1 наблюдение
        t.observe(
            vec![
                chrome(),
                RawProc {
                    exe: "svchost.exe".into(),
                    path: Some(r"C:\Windows\System32\svchost.exe".into()),
                    ver: None,
                },
            ],
            1_700_000_030,
            r"C:\Windows",
            &read,
        );
        t.observe(
            vec![RawProc {
                exe: "csrss.exe".into(),
                path: None,
                ver: None,
            }],
            1_700_000_030,
            r"C:\Windows",
            &read,
        );
        let r = t.report();
        assert_eq!(r.len(), 1, "процесс без пути (системный/чужой) пропускается");
        assert_eq!(
            (r[0].samples, r[0].first_seen.as_str(), r[0].last_seen.as_str()),
            (2, "2023-11-14T22:13:20Z", "2023-11-14T22:13:50Z")
        );
        assert_eq!(r[0].product_name.as_deref(), Some("Google Chrome"));
        assert_eq!(calls.get(), 1, "VERSIONINFO читается один раз на путь");
        t.last_sent = 1_700_000_000; // как в usage_tick: отсчёт от старта
        assert!(
            !t.due(1_700_000_030, 300) && t.due(1_700_000_060, 300),
            "первая отправка — через 60 с от старта, а не через 300"
        );
        t.clear(1_700_000_060);
        assert!(t.is_empty());
        assert_eq!(t.last_sent, 1_700_000_060);
        assert!(
            !t.due(1_700_000_200, 300) && t.due(1_700_000_360, 300),
            "после первой — по интервалу"
        );
    }
}
