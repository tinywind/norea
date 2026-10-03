use std::{
    cell::UnsafeCell,
    ffi::c_void,
    ptr,
    sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc},
    time::{Duration, Instant},
};

use windows::{
    core::{w, Error, PCWSTR},
    Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
        WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ENABLE_SSL_REVOCATION,
        WinHttpSetStatusCallback, WINHTTP_ASYNC_RESULT, WINHTTP_FLAG_ASYNC,
        WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING, WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE,
        WINHTTP_CALLBACK_STATUS_READ_COMPLETE, WINHTTP_CALLBACK_STATUS_REQUEST_ERROR,
        WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, WINHTTP_OPTION_CONTEXT_VALUE,
        WINHTTP_FLAG_SECURE, WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2, WINHTTP_OPTION_ENABLE_FEATURE,
        WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER,
        WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    },
};

const VPN_GATE_HOST: PCWSTR = w!("www.vpngate.net");
const VPN_GATE_PATH: PCWSTR = w!("/api/iphone/");
const READ_BUFFER_BYTES: usize = 64 * 1024;

pub(super) struct RequestCancellation(Arc<AtomicBool>);

impl RequestCancellation {
    pub(super) fn new() -> Self { Self(Arc::new(AtomicBool::new(false))) }
    pub(super) fn flag(&self) -> Arc<AtomicBool> { self.0.clone() }
}

impl Drop for RequestCancellation {
    fn drop(&mut self) { self.0.store(true, Ordering::Release); }
}

enum HttpEvent {
    Sent,
    Headers,
    Read(Vec<u8>),
    Error(u32),
}

struct RequestContext {
    events: mpsc::Sender<HttpEvent>,
    // WinHTTP owns writes until READ_COMPLETE; the callback copies the completed bytes.
    buffer: UnsafeCell<[u8; READ_BUFFER_BYTES]>,
}

unsafe extern "system" fn request_callback(
    _handle: *mut c_void, context: usize, status: u32,
    information: *mut c_void, length: u32,
) {
    if context == 0 { return; }
    if status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING {
        // WinHTTP guarantees this is the final callback, after pending buffer use ends.
        drop(unsafe { Box::from_raw(context as *mut RequestContext) });
        return;
    }
    let context = unsafe { &*(context as *const RequestContext) };
    let event = match status {
        WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE => HttpEvent::Sent,
        WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE => HttpEvent::Headers,
        WINHTTP_CALLBACK_STATUS_READ_COMPLETE => HttpEvent::Read(if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(information.cast::<u8>(), length as usize) }.to_vec()
        }),
        WINHTTP_CALLBACK_STATUS_REQUEST_ERROR => {
            HttpEvent::Error(unsafe { (*(information.cast::<WINHTTP_ASYNC_RESULT>())).dwError })
        }
        _ => return,
    };
    let _ = context.events.send(event);
}

struct AsyncRequest {
    handle: WinHttpHandle,
    context: usize,
    events: mpsc::Receiver<HttpEvent>,
}

impl AsyncRequest {
    fn new(handle: WinHttpHandle) -> Result<Self, String> {
        let (events, receiver) = mpsc::channel();
        let context = Box::into_raw(Box::new(RequestContext {
            events, buffer: UnsafeCell::new([0; READ_BUFFER_BYTES]),
        })) as usize;
        let installed = (|| {
            unsafe {
                WinHttpSetOption(Some(handle.raw().cast_const()), WINHTTP_OPTION_CONTEXT_VALUE,
                    Some(&context.to_ne_bytes()))
            }.map_err(|error| format!("could not configure VPN Gate request context: {error}"))?;
            let previous = unsafe {
                WinHttpSetStatusCallback(handle.raw(), Some(request_callback),
                    WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE |
                    WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE |
                    WINHTTP_CALLBACK_STATUS_READ_COMPLETE |
                    WINHTTP_CALLBACK_STATUS_REQUEST_ERROR |
                    WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING, 0)
            };
            if previous.is_some_and(|callback| callback as usize == usize::MAX) {
                return Err(format!("could not configure VPN Gate callbacks: {}", Error::from_win32()));
            }
            Ok(())
        })();
        if let Err(error) = installed {
            unsafe { drop(Box::from_raw(context as *mut RequestContext)); }
            return Err(error);
        }
        // The callback owns the context until HANDLE_CLOSING, including cancellation.
        Ok(Self { handle, context, events: receiver })
    }

    fn raw(&self) -> *mut c_void { self.handle.raw() }

    fn buffer(&self) -> *mut c_void {
        unsafe { (*(self.context as *const RequestContext)).buffer.get().cast() }
    }

    fn next(&self, deadline: Instant, cancelled: &AtomicBool) -> Result<HttpEvent, String> {
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err("VPN Gate server query was cancelled".to_string());
            }
            let remaining = remaining_timeout_millis(deadline)? as u64;
            match self.events.recv_timeout(Duration::from_millis(remaining.min(100))) {
                Ok(HttpEvent::Error(code)) => return Err(format!("VPN Gate Windows HTTP request failed (WinHTTP {code})")),
                Ok(event) => return Ok(event),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err("VPN Gate HTTP callback channel closed".to_string()),
            }
        }
    }
}

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
    cancelled: Arc<AtomicBool>,
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
                WINHTTP_FLAG_ASYNC,
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
    let request = AsyncRequest::new(WinHttpHandle::new(
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
    )?)?;

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
    if cancelled.load(Ordering::Acquire) {
        return Err("VPN Gate server query was cancelled".to_string());
    }
    set_remaining_timeouts(&request.handle, connect_timeout_ms, deadline)?;
    unsafe { WinHttpSendRequest(request.raw(), None, None, 0, 0, request.context) }
        .map_err(|error| format!("could not load the VPN Gate server list: {error}"))?;
    if !matches!(request.next(deadline, &cancelled)?, HttpEvent::Sent) {
        return Err("unexpected VPN Gate HTTP send completion".to_string());
    }
    set_remaining_timeouts(&request.handle, connect_timeout_ms, deadline)?;
    unsafe { WinHttpReceiveResponse(request.raw(), ptr::null_mut()) }
        .map_err(|error| format!("could not load the VPN Gate server list: {error}"))?;
    if !matches!(request.next(deadline, &cancelled)?, HttpEvent::Headers) {
        return Err("unexpected VPN Gate HTTP header completion".to_string());
    }

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
    loop {
        set_remaining_timeouts(&request.handle, connect_timeout_ms, deadline)?;
        unsafe {
            WinHttpReadData(
                request.raw(),
                request.buffer(),
                READ_BUFFER_BYTES as u32,
                ptr::null_mut(),
            )
        }
        .map_err(|error| format!("could not read the VPN Gate server list: {error}"))?;
        let HttpEvent::Read(bytes) = request.next(deadline, &cancelled)? else {
            return Err("unexpected VPN Gate HTTP read completion".to_string());
        };
        if bytes.is_empty() {
            break;
        }
        extend_bounded(&mut response, &bytes, max_response_bytes)?;
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
