use serde::{Serialize, Serializer};

/// Error type for Tauri commands: any error converts into it and is sent to the UI as a string.
#[derive(Debug)]
pub struct Error(pub anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(e: E) -> Self {
        Error(e.into())
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.0)
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type CmdResult<T> = Result<T, Error>;

#[macro_export]
macro_rules! bail_msg {
    ($($t:tt)*) => { return Err(anyhow::anyhow!($($t)*).into()) };
}
