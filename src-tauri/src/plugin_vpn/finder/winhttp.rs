use std::{
    ffi::c_void,
    ptr,
    time::{Duration, Instant},
};

use windows::{
    core::{w, Error, PCWSTR},
    Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
        WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ENABLE_SSL_REVOCATION,
        WINHTTP_FLAG_SECURE, WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2, WINHTTP_OPTION_ENABLE_FEATURE,
        WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER,
        WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    },
};

const VPN_GATE_HOST: PCWSTR = w!("www.vpngate.net");
const VPN_GATE_PATH: PCWSTR = w!("/api/iphone/");
const READ_BUFFER_BYTES: usize = 64 * 1024;

struct WinHttpHandle(*mut c_void);

impl WinHttpHandle {
    fn new(raw: *mut c_void, operation: &str) -> Result<Self, String> {
        if raw.is_null() {
            Err(format!("{operation}: {}", Error::from_win32()))
        } else {
            Ok(Self(raw))
        }
    }

    fn raw(&self) -> *mut c_void {
        self.0
    }
}

impl Drop for WinHttpHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

pub(super) fn fetch_vpn_gate_response(
    connect_timeout: Duration,
    request_timeout: Duration,
    max_response_bytes: usize,
) -> Result<Vec<u8>, String> {
    let connect_timeout_ms = timeout_millis(connect_timeout)?;
    let deadline = Instant::now()
        .checked_add(request_timeout)
        .ok_or_else(|| "VPN Gate HTTP request deadline overflowed".to_string())?;
    let session = WinHttpHandle::new(
        unsafe {
            WinHttpOpen(
                w!("Norea"),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                PCWSTR::null(),
                PCWSTR::null(),
                0,
            )
        },
        "could not open the VPN Gate Windows HTTP session",
    )?;
    let secure_protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2.to_ne_bytes();
    unsafe {
        WinHttpSetOption(
            Some(session.raw().cast_const()),
            WINHTTP_OPTION_SECURE_PROTOCOLS,
            Some(&secure_protocols),
        )
    }
    .map_err(|error| format!("could not require TLS 1.2 for VPN Gate: {error}"))?;

    let connection = WinHttpHandle::new(
        unsafe { WinHttpConnect(session.raw(), VPN_GATE_HOST, 443, 0) },
        "could not connect to the VPN Gate server",
    )?;
    let request = WinHttpHandle::new(
        unsafe {
            WinHttpOpenRequest(
                connection.raw(),
                w!("GET"),
                VPN_GATE_PATH,
                PCWSTR::null(),
                PCWSTR::null(),
                ptr::null(),
                WINHTTP_FLAG_SECURE,
            )
        },
        "could not create the VPN Gate HTTP request",
    )?;

    let enabled_features = WINHTTP_ENABLE_SSL_REVOCATION.to_ne_bytes();
    unsafe {
        WinHttpSetOption(
            Some(request.raw().cast_const()),
            WINHTTP_OPTION_ENABLE_FEATURE,
            Some(&enabled_features),
        )
    }
    .map_err(|error| format!("could not enable VPN Gate certificate revocation checks: {error}"))?;
    let redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER.to_ne_bytes();
    unsafe {
        WinHttpSetOption(
            Some(request.raw().cast_const()),
            WINHTTP_OPTION_REDIRECT_POLICY,
            Some(&redirect_policy),
        )
    }
    .map_err(|error| format!("could not disable VPN Gate HTTP redirects: {error}"))?;
    set_remaining_timeouts(&request, connect_timeout_ms, deadline)?;
    unsafe { WinHttpSendRequest(request.raw(), None, None, 0, 0, 0) }
        .map_err(|error| format!("could not load the VPN Gate server list: {error}"))?;
    ensure_before_deadline(deadline)?;
    set_remaining_timeouts(&request, connect_timeout_ms, deadline)?;
    unsafe { WinHttpReceiveResponse(request.raw(), ptr::null_mut()) }
        .map_err(|error| format!("could not load the VPN Gate server list: {error}"))?;
    ensure_before_deadline(deadline)?;

    let mut status = 0u32;
    let mut status_bytes = size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request.raw(),
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut status_bytes,
            ptr::null_mut(),
        )
    }
    .map_err(|error| format!("could not read the VPN Gate HTTP status: {error}"))?;
    if !(200..=299).contains(&status) {
        return Err(format!("VPN Gate server list returned HTTP {status}"));
    }

    let mut response = Vec::new();
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    loop {
        set_remaining_timeouts(&request, connect_timeout_ms, deadline)?;
        let mut read = 0u32;
        unsafe {
            WinHttpReadData(
                request.raw(),
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut read,
            )
        }
        .map_err(|error| format!("could not read the VPN Gate server list: {error}"))?;
        ensure_before_deadline(deadline)?;
        if read == 0 {
            break;
        }
        extend_bounded(&mut response, &buffer[..read as usize], max_response_bytes)?;
    }
    Ok(response)
}

fn set_remaining_timeouts(
    request: &WinHttpHandle,
    connect_timeout_ms: i32,
    deadline: Instant,
) -> Result<(), String> {
    let remaining_timeout_ms = remaining_timeout_millis(deadline)?;
    let bounded_connect_timeout_ms = connect_timeout_ms.min(remaining_timeout_ms);
    unsafe {
        WinHttpSetTimeouts(
            request.raw(),
            bounded_connect_timeout_ms,
            bounded_connect_timeout_ms,
            remaining_timeout_ms,
            remaining_timeout_ms,
        )
    }
    .map_err(|error| format!("could not configure VPN Gate HTTP timeouts: {error}"))
}

fn ensure_before_deadline(deadline: Instant) -> Result<(), String> {
    remaining_timeout_millis(deadline).map(|_| ())
}

fn remaining_timeout_millis(deadline: Instant) -> Result<i32, String> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "VPN Gate server list request timed out".to_string())?;
    timeout_millis(remaining)
}

fn timeout_millis(timeout: Duration) -> Result<i32, String> {
    i32::try_from(timeout.as_millis().max(1))
        .map_err(|_| "VPN Gate HTTP timeout exceeds the Windows limit".to_string())
}

fn extend_bounded(response: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> Result<(), String> {
    let next_length = response
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| "VPN Gate server list size overflowed".to_string())?;
    if next_length > max_bytes {
        return Err(format!(
            "VPN Gate server list exceeds the {max_bytes}-byte limit"
        ));
    }
    response.extend_from_slice(chunk);
    Ok(())
}
