pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Quote a string for POSIX sh.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Log a failure that must not abort the caller (audit rows, settings, cleanup of secrets).
pub fn log_err<T, E: std::fmt::Display>(what: &str, r: Result<T, E>) {
    if let Err(e) = r {
        log::warn!("{what}: {e:#}");
    }
}
