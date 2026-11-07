use std::fmt;

use serde::{Deserialize, Serialize};

/// Identifies connections accepted after a caller starts one browser operation.
/// A route generation is unique across proxies, so cursors cannot cross workers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginVpnTransportCursor {
    pub(super) route_generation: u64,
    pub(super) next_request_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PluginVpnTransportFailureKind {
    Dns,
    Tcp,
    Tunnel,
    Proxy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginVpnTransportFailure {
    pub(super) route_generation: u64,
    pub(super) request_id: u64,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) kind: PluginVpnTransportFailureKind,
    pub(super) message: String,
}

/// Keep the failure stage when CONNECT/HTTP proxy errors hide it from WebView.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ProxyConnectError {
    pub(super) kind: PluginVpnTransportFailureKind,
    pub(super) message: String,
}

impl ProxyConnectError {
    pub(super) fn dns(message: impl Into<String>) -> Self {
        Self {
            kind: PluginVpnTransportFailureKind::Dns,
            message: message.into(),
        }
    }

    pub(super) fn tcp(message: impl Into<String>) -> Self {
        Self {
            kind: PluginVpnTransportFailureKind::Tcp,
            message: message.into(),
        }
    }

    pub(super) fn tunnel(message: impl Into<String>) -> Self {
        Self {
            kind: PluginVpnTransportFailureKind::Tunnel,
            message: message.into(),
        }
    }

    pub(super) fn proxy(message: impl Into<String>) -> Self {
        Self {
            kind: PluginVpnTransportFailureKind::Proxy,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProxyConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for ProxyConnectError {}

// Lifecycle/channel errors have no DNS or TCP result. Their existing strings
// remain useful, but must not be mistaken for a per-host DNS failure.
impl From<String> for ProxyConnectError {
    fn from(message: String) -> Self {
        Self::tunnel(message)
    }
}

impl From<&str> for ProxyConnectError {
    fn from(message: &str) -> Self {
        Self::tunnel(message)
    }
}
