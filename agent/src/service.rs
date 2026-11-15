//! Служба Windows «sam-agent»: установка/удаление и точка входа SCM.
//! `sam-agent.exe install` — от администратора; берёт настройки из sam-agent.json рядом с exe (или аргументов),
//! регистрирует службу с автозапуском (`… service --config <путь>`) и сразу запускает.
//! Поменять настройки службы: правим sam-agent.json → `sc stop sam-agent` → `sc start sam-agent`.
//! Ограничение: токен виден в конфигурации службы (`sc qc sam-agent`) администраторам ПК — для хакатона приемлемо.
use std::ffi::OsString;
use std::sync::mpsc;
use std::time::Duration;

use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceInfo,
    ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

pub const NAME: &str = "sam-agent";

define_windows_service!(ffi_service_main, service_main);

/// Вызывается, когда процесс запущен SCM с аргументом `service`.
pub fn run_as_service() -> Result<(), String> {
    service_dispatcher::start(NAME, ffi_service_main)
        .map_err(|e| format!("не удалось подключиться к диспетчеру служб (запускать как службу, а не из консоли): {e}"))
}

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        crate::log::error(&format!("служба: {e}"));
    }
}

fn status(state: ServiceState, accept: ServiceControlAccept) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    }
}

fn run_service() -> windows_service::Result<()> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let handler = move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let handle = service_control_handler::register(NAME, handler)?;
    handle.set_service_status(status(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
    ))?;

    // командная строка службы: sam-agent.exe service --config … ; ошибки настроек не останавливают службу
    let rest: Vec<String> = std::env::args().skip(2).collect();
    crate::log::info("служба запущена");
    crate::run_forever(&rest, &|d| stop_rx.recv_timeout(d).is_ok());
    crate::log::info("служба остановлена");
    handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))?;
    Ok(())
}

pub fn install(rest: &[String]) -> Result<(), String> {
    let cfg = crate::parse_config(rest)?; // проверить параметры до регистрации
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mgr = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| format!("нужен запуск от имени администратора: {e}"))?;
    let mut launch = vec![OsString::from("service")];
    launch.extend(rest.iter().map(OsString::from));
    // файл настроек передаём явным абсолютным путём: у службы рабочая папка System32
    if let (Some(f), false) = (&cfg.config_file, rest.iter().any(|a| a == "--config")) {
        launch.push(OsString::from("--config"));
        launch.push(f.as_os_str().to_owned());
    }
    let info = ServiceInfo {
        name: OsString::from(NAME),
        display_name: OsString::from("EasySAM Agent (учёт установленного ПО)"),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe.clone(),
        launch_arguments: launch,
        dependencies: vec![],
        account_name: None, // LocalSystem: читает HKLM и HKEY_USERS
        account_password: None,
    };
    let svc = mgr
        .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
        .map_err(|e| format!("не удалось создать службу (уже установлена? тогда сначала uninstall): {e}"))?;
    let _ = svc.set_description(
        "Отправляет список установленного ПО и изменения (установка/удаление/обновление) на сервер EasySAM",
    );
    svc.start::<&str>(&[])
        .map_err(|e| format!("служба создана, но не запустилась: {e}"))?;
    crate::log::info(&format!("служба {NAME} установлена и запущена ({})", exe.display()));
    Ok(())
}

/// Служба уже установлена → убедиться, что работает. Err — службы нет или нет прав.
pub fn ensure_running() -> Result<&'static str, String> {
    let mgr = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).map_err(|e| e.to_string())?;
    let svc = mgr
        .open_service(NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::START)
        .map_err(|e| e.to_string())?;
    if svc
        .query_status()
        .map(|s| s.current_state == ServiceState::Running)
        .unwrap_or(false)
    {
        return Ok("служба sam-agent уже работает");
    }
    svc.start::<&str>(&[]).map_err(|e| e.to_string())?;
    Ok("служба sam-agent запущена")
}

/// Остановить службу, если она есть (для `stop`).
pub fn stop() -> Result<(), String> {
    let mgr = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).map_err(|e| e.to_string())?;
    let svc = mgr
        .open_service(NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP)
        .map_err(|e| e.to_string())?;
    svc.stop().map(|_| ()).map_err(|e| e.to_string())
}

pub fn uninstall() -> Result<(), String> {
    let mgr = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("нужен запуск от имени администратора: {e}"))?;
    let svc = mgr
        .open_service(
            NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
        )
        .map_err(|e| format!("служба {NAME} не найдена: {e}"))?;
    if svc
        .query_status()
        .map(|s| s.current_state != ServiceState::Stopped)
        .unwrap_or(false)
    {
        let _ = svc.stop();
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(250));
            if svc
                .query_status()
                .map(|s| s.current_state == ServiceState::Stopped)
                .unwrap_or(true)
            {
                break;
            }
        }
    }
    svc.delete().map_err(|e| e.to_string())?;
    crate::log::info(&format!("служба {NAME} удалена"));
    Ok(())
}
