//! Codex / ChatGPT OAuth loopback (NOT GitHub).
//!
//! The desktop half of `@shot2issue/core`'s `OAuthLoopbackPort`. The Codex OAuth client
//! (`app_EMoamEEZ73f0CkXaXp7hrann`, see core/src/ai/ai.ts) registers EXACTLY ONE redirect:
//! `http://localhost:1455/auth/callback`. So we MUST bind that exact host:port and advertise
//! that exact redirect_uri; the later token exchange (exchangeCode in core) sends the identical
//! value and the OpenAI server checks it byte-for-byte.
//!
//! Flow (driven from src/lib/platform.ts's `oauth.capture()`):
//!   1. `oauth_loopback_start` binds 127.0.0.1:1455 NOW (so the listener is ready before the
//!      browser opens) and returns the redirect URI string.
//!   2. The frontend calls `beginAuth(redirectUri)` + opens the authorize URL in the system
//!      browser (ShellPort).
//!   3. The user signs in; OpenAI redirects the browser to
//!      http://localhost:1455/auth/callback?code=...&state=... .
//!   4. `oauth_loopback_wait` accepts that one connection, reads the HTTP request line, extracts
//!      the full callback URL, serves a "you may close this window" page, and returns the URL.
//!   5. The frontend hands the URL to `completeAuth()` (state check + code exchange).
//!
//! Only loopback (127.0.0.1) is bound, so no firewall prompt and nothing is exposed off-box.
//! A single capture is in flight at a time (the listener lives in a process-global slot); a new
//! `start` replaces any abandoned prior listener.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;

use super::{Result, ServiceError};

/// The loopback host:port the Codex client registers. Bind and advertise this EXACTLY.
const LOOPBACK_ADDR: &str = "127.0.0.1:1455";
/// The advertised redirect URI. Uses `localhost` (not `127.0.0.1`) because that is the literal
/// string the Codex client registered — the OpenAI authorize/token endpoints match it verbatim.
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
/// Cap the wait so a user who never completes sign-in doesn't leak the bound socket forever.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(300);

/// The bound-but-not-yet-accepted listener, parked between `start` and `wait`.
static LISTENER: Mutex<Option<TcpListener>> = Mutex::new(None);

/// Bind the loopback listener and return the redirect URI to advertise. Idempotent in spirit: a
/// second `start` drops any previous (abandoned) listener and rebinds.
pub fn start() -> Result<String> {
    let listener = TcpListener::bind(LOOPBACK_ADDR)
        .map_err(|e| ServiceError::Other(format!("cannot bind {LOOPBACK_ADDR} for OAuth loopback: {e}")))?;
    // Non-blocking would complicate the accept loop; instead we set a read timeout per-connection
    // in `wait`. Store the listener for `wait` to consume.
    *LISTENER
        .lock()
        .map_err(|_| ServiceError::Other("oauth listener lock poisoned".into()))? = Some(listener);
    Ok(REDIRECT_URI.to_string())
}

/// Accept the single OAuth callback connection and return the full callback URL (the GET path +
/// query reconstructed as an absolute URL). Blocking; the command wrapper runs it off the main
/// thread. Errors if `start` was not called, the wait times out, or the request is malformed.
pub fn wait() -> Result<String> {
    let listener = LISTENER
        .lock()
        .map_err(|_| ServiceError::Other("oauth listener lock poisoned".into()))?
        .take()
        .ok_or_else(|| ServiceError::Other("oauth_loopback_wait called before oauth_loopback_start".into()))?;

    // The browser may make extra probe connections (favicon, etc.). Accept connections until one
    // carries a request line whose path is /auth/callback, or the overall deadline passes.
    let deadline = std::time::Instant::now() + ACCEPT_TIMEOUT;
    listener
        .set_nonblocking(false)
        .map_err(ServiceError::Io)?;

    loop {
        if std::time::Instant::now() >= deadline {
            return Err(ServiceError::Other("OAuth sign-in timed out (no callback received).".into()));
        }
        // A short SO accept poll isn't portable; instead rely on the per-stream read timeout plus
        // the loop deadline. accept() blocks until a connection arrives; the OS will return one
        // promptly once the browser redirects.
        let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(e) => return Err(ServiceError::Other(format!("OAuth loopback accept failed: {e}"))),
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

        let request_line = read_request_line(&mut stream);
        let Some(path_and_query) = request_line.and_then(|l| target_from_request_line(&l)) else {
            // Not a parseable GET; serve a minimal 400 and keep waiting for the real callback.
            write_response(&mut stream, "400 Bad Request", "Bad request.");
            continue;
        };

        if !path_and_query.starts_with("/auth/callback") {
            // A favicon or other probe; acknowledge and keep waiting.
            write_response(&mut stream, "404 Not Found", "Not found.");
            continue;
        }

        // Reconstruct the absolute URL the core's parseRedirect() expects. Use `localhost` so it
        // matches the advertised redirect (the query string is what carries code/state/error).
        let full_url = format!("http://localhost:1455{path_and_query}");
        write_response(
            &mut stream,
            "200 OK",
            "shot2issue is signed in. You can close this window and return to the app.",
        );
        return Ok(full_url);
    }
}

/// Read just the first line ("GET /path?query HTTP/1.1") of the incoming request. We don't need
/// headers or a body — the authorization code rides in the query string.
fn read_request_line(stream: &mut std::net::TcpStream) -> Option<String> {
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buf[..n]);
    text.lines().next().map(|s| s.to_string())
}

/// Extract the request target (path + query) from a request line like
/// "GET /auth/callback?code=abc&state=xyz HTTP/1.1". Returns None if it isn't a GET request line.
fn target_from_request_line(line: &str) -> Option<String> {
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let target = parts.next()?;
    Some(target.to_string())
}

/// Write a minimal HTML response and flush. Best-effort: the browser only needs to render
/// something for the user; the captured URL has already been extracted from the request line.
fn write_response(stream: &mut std::net::TcpStream, status: &str, message: &str) {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>shot2issue</title>\
         <style>body{{font:15px -apple-system,Segoe UI,sans-serif;display:grid;place-items:center;\
         height:100vh;margin:0;background:#0d0d0f;color:#e8e8ea}}div{{max-width:30rem;text-align:center;\
         padding:2rem}}</style></head><body><div>{message}</div></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
