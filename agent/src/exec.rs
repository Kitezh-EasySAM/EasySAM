//! Запуск штатных консольных утилит продуктов (cpconfig, avp.com): без окна, с таймаутом, вывод в UTF-8.
//! Только Windows. Аргументы передаются списком (без оболочки) — подстановка команд невозможна.
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Вывод консольных утилит: UTF-8, иначе OEM-кодировка (cp866), иначе ANSI (cp1251).
pub fn decode(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let conv = |cp: u32| -> String {
        use windows_sys::Win32::Globalization::MultiByteToWideChar;
        // SAFETY: первый вызов узнаёт длину, второй пишет ровно в буфер этой длины.
        unsafe {
            let n = MultiByteToWideChar(cp, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
            if n <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; n as usize];
            MultiByteToWideChar(cp, 0, bytes.as_ptr(), bytes.len() as i32, buf.as_mut_ptr(), n);
            String::from_utf16_lossy(&buf)
        }
    };
    let oem = conv(1); // CP_OEMCP
    if oem
        .chars()
        .any(|c| ('а'..='я').contains(&c.to_lowercase().next().unwrap_or(c)))
    {
        oem
    } else {
        conv(1251)
    }
}

/// Запуск утилиты без окна, с таймаутом. Ok((успех, вывод)).
pub fn run(exe: &str, args: &[&str]) -> Result<(bool, String), String> {
    let mut child = Command::new(exe)
        .args(args)
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{exe}: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > Duration::from_secs(30) => {
                let _ = child.kill();
                return Err(format!("{exe}: не ответил за 30 с"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let mut text = decode(&out.stdout);
    text.push_str(&decode(&out.stderr));
    Ok((out.status.success(), text.trim().to_string()))
}
