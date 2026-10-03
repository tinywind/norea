use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Connectivity {
    Unknown,
    Offline,
    Limited,
    Online,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkStatus {
    pub(crate) connectivity: Connectivity,
    pub(crate) revision: u64,
    #[serde(skip)]
    route: String,
}

static STATUS: OnceLock<watch::Sender<NetworkStatus>> = OnceLock::new();

fn channel() -> &'static watch::Sender<NetworkStatus> {
    STATUS.get_or_init(|| {
        watch::channel(NetworkStatus {
            connectivity: Connectivity::Unknown,
            revision: 0,
            route: String::new(),
        }).0
    })
}

pub(crate) fn subscribe() -> watch::Receiver<NetworkStatus> {
    channel().subscribe()
}

#[tauri::command]
pub(crate) fn network_status() -> NetworkStatus {
    channel().borrow().clone()
}

pub(crate) fn require_online() -> Result<(), String> {
    if channel().borrow().connectivity == Connectivity::Online {
        Ok(())
    } else {
        Err("Internet access is unavailable; waiting for the network".to_string())
    }
}

fn publish(connectivity: Connectivity, route: String) {
    channel().send_if_modified(|status| {
        if status.connectivity == connectivity && status.route == route {
            return false;
        }
        status.connectivity = connectivity;
        status.route = route;
        status.revision = status.revision.wrapping_add(1);
        true
    });
}

pub(crate) fn initialize(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::initialize();
    let app = app.clone();
    let mut changes = subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = changes.borrow_and_update().clone();
            if let Err(error) = app.emit("network-status", &status) {
                log::warn!("could not emit network status: {error}");
            }
            if changes.changed().await.is_err() { break; }
        }
    });
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidNetworkState_publish(
    mut env: jni::EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    connectivity: jni::sys::jint,
    route: jni::objects::JString<'_>,
) {
    use jni::errors::ThrowRuntimeExAndDefault;
    env.with_env(|env| -> jni::errors::Result<()> {
        let route = route.try_to_string(env)?;
        let connectivity = match connectivity {
            1 => Connectivity::Offline,
            2 => Connectivity::Limited,
            3 => Connectivity::Online,
            _ => Connectivity::Unknown,
        };
        publish(connectivity, route);
        Ok(())
    }).resolve::<ThrowRuntimeExAndDefault>();
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::sync::Mutex;
    use ::windows::Networking::Connectivity::{
        NetworkConnectivityLevel, NetworkInformation, NetworkStatusChangedEventHandler,
    };

    static OBSERVATION: Mutex<()> = Mutex::new(());

    fn refresh() {
        let _observation = OBSERVATION.lock().expect("Windows network observation lock");
        let state = (|| -> ::windows::core::Result<_> {
            let profile = NetworkInformation::GetInternetConnectionProfile()?;
            let connectivity = match profile.GetNetworkConnectivityLevel()? {
                NetworkConnectivityLevel::InternetAccess => Connectivity::Online,
                NetworkConnectivityLevel::None => Connectivity::Offline,
                _ => Connectivity::Limited,
            };
            let route = format!("{:?}", profile.NetworkAdapter()?.NetworkAdapterId()?);
            Ok((connectivity, route))
        })();
        match state {
            Ok((connectivity, route)) => publish(connectivity, route),
            // A missing connection profile is returned as a null COM interface.
            Err(error) if error.code() == ::windows::core::HRESULT(0x80004003u32 as i32) => {
                publish(Connectivity::Offline, String::new());
            }
            Err(error) => {
                log::warn!("could not read Windows network state: {error}");
                publish(Connectivity::Unknown, String::new());
            }
        }
    }

    pub(super) fn initialize() {
        let handler = NetworkStatusChangedEventHandler::new(|_| {
            refresh();
            Ok(())
        });
        if let Err(error) = NetworkInformation::NetworkStatusChanged(&handler) {
            log::warn!("could not watch Windows network state: {error}");
            return;
        }
        // The static event registration lives for the application process.
        refresh();
    }
}
