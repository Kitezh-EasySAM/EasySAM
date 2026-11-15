//! Серийный номер из таблицы SMBIOS (тот же источник, что WMI Win32_BIOS / `wmic bios get serialnumber`).
//! В реестре серийника BIOS нет — поэтому читаем сырую таблицу через GetSystemFirmwareTable('RSMB').
//! Приоритет: тип 1 System Information (Dell service tag, «VMware-56 4d …») → тип 2 Baseboard → тип 3 Chassis.
//! Разбор — чистая функция, тестируется на любой ОС.
#![cfg_attr(not(windows), allow(dead_code))] // часть функций вызывается только в Windows-сборке
use crate::collect::is_bad_serial;

/// Строки структуры (нумерация с 1) из области после форматированной части; возвращает (строки, индекс следующей структуры).
fn strings_at(t: &[u8], start: usize) -> (Vec<String>, usize) {
    let mut out = Vec::new();
    let mut j = start;
    // пустой набор строк кодируется двумя нулями подряд
    if t.get(j) == Some(&0) && t.get(j + 1) == Some(&0) {
        return (out, j + 2);
    }
    let mut cur = Vec::new();
    while j < t.len() {
        if t[j] == 0 {
            out.push(String::from_utf8_lossy(&cur).trim().to_string());
            cur.clear();
            if t.get(j + 1) == Some(&0) {
                return (out, j + 2);
            }
        } else {
            cur.push(t[j]);
        }
        j += 1;
    }
    (out, t.len())
}

/// `raw` — буфер RawSMBIOSData: 4 байта версии + u32 длина таблицы + таблица.
pub fn serial_from_raw(raw: &[u8]) -> Option<String> {
    if raw.len() < 8 {
        return None;
    }
    let len = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
    let t = &raw[8..raw.len().min(8 + len)];
    let mut found: [Option<String>; 4] = Default::default(); // индекс = тип структуры 1..3
    let mut i = 0;
    while i + 4 <= t.len() {
        let (typ, flen) = (t[i], t[i + 1] as usize);
        if flen < 4 || i + flen > t.len() {
            break;
        }
        let (strs, next) = strings_at(t, i + flen);
        if (1..=3).contains(&typ) && flen > 7 {
            let idx = t[i + 7] as usize; // смещение 07h: Serial Number (номер строки) у типов 1, 2 и 3
            if idx > 0 {
                if let Some(s) = strs.get(idx - 1).filter(|s| !is_bad_serial(s)) {
                    found[typ as usize].get_or_insert_with(|| s.clone());
                }
            }
        }
        if typ == 127 {
            break; // End-of-Table
        }
        i = next;
    }
    found[1].take().or(found[2].take()).or(found[3].take())
}

#[cfg(windows)]
pub fn read_raw() -> Option<Vec<u8>> {
    use windows_sys::Win32::System::SystemInformation::GetSystemFirmwareTable;
    let sig = u32::from_be_bytes(*b"RSMB");
    // SAFETY: первый вызов с пустым буфером возвращает нужный размер; второй пишет не больше size байт.
    unsafe {
        let size = GetSystemFirmwareTable(sig, 0, std::ptr::null_mut(), 0);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let n = GetSystemFirmwareTable(sig, 0, buf.as_mut_ptr().cast(), size);
        if n == 0 || n > size {
            return None;
        }
        buf.truncate(n as usize);
        Some(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Собирает RawSMBIOSData из структур (тип, форматированная часть без заголовка, строки).
    fn raw(structs: &[(u8, Vec<u8>, &[&str])]) -> Vec<u8> {
        let mut t = Vec::new();
        for (h, (typ, body, strs)) in structs.iter().enumerate() {
            t.push(*typ);
            t.push((4 + body.len()) as u8);
            t.extend_from_slice(&(h as u16).to_le_bytes());
            t.extend_from_slice(body);
            if strs.is_empty() {
                t.extend_from_slice(&[0, 0]);
            } else {
                for s in *strs {
                    t.extend_from_slice(s.as_bytes());
                    t.push(0);
                }
                t.push(0);
            }
        }
        let mut r = vec![0, 3, 4, 0];
        r.extend_from_slice(&(t.len() as u32).to_le_bytes());
        r.extend(t);
        r
    }
    // тело типа 1/2/3: байты 04h..07h; смещение 07h (= body[3]) — номер строки серийника
    fn body(serial_idx: u8) -> Vec<u8> {
        vec![1, 2, 3, serial_idx, 0, 0, 0, 0]
    }

    #[test]
    fn vmware_system_serial() {
        let r = raw(&[
            (0, vec![1, 2, 0, 0], &["Phoenix", "6.00"]), // BIOS, без серийника
            (
                1,
                body(4),
                &[
                    "VMware, Inc.",
                    "VMware20,1",
                    "None",
                    "VMware-56 4d 1a 2b c3 d4 e5 f6-01 02 03 04 05 06 07 08",
                ],
            ),
            (127, vec![], &[]),
        ]);
        assert_eq!(
            serial_from_raw(&r).as_deref(),
            Some("VMware-56 4d 1a 2b c3 d4 e5 f6-01 02 03 04 05 06 07 08")
        );
    }

    #[test]
    fn falls_back_to_baseboard_then_chassis() {
        let r = raw(&[
            (1, body(1), &["To be filled by O.E.M."]),
            (2, body(1), &["Default string"]),
            (3, body(2), &["ACME", "CHS-12345"]),
            (127, vec![], &[]),
        ]);
        assert_eq!(serial_from_raw(&r).as_deref(), Some("CHS-12345"));
    }

    #[test]
    fn dell_service_tag_and_garbage_input() {
        let r = raw(&[
            (1, body(2), &["Dell Inc.", "B1RG0S2"]),
            (2, body(1), &["/B1RG0S2/CN1296/"]),
        ]);
        assert_eq!(serial_from_raw(&r).as_deref(), Some("B1RG0S2"));
        assert_eq!(serial_from_raw(&[]), None);
        assert_eq!(serial_from_raw(&[0, 3, 4, 0, 200, 0, 0, 0, 1, 99]), None); // обрезанная таблица не паникует
    }
}
