use std::sync::Arc;

use tauri::AppHandle;

use crate::db::Db;
use crate::monitor::Monitors;
use crate::prompts::Prompts;
use crate::ssh::Pool;
use crate::term::Terms;
use crate::transfer::Transfers;
use crate::tunnel::Tunnels;
use crate::vault::Vault;

pub struct Ctx {
    pub app: AppHandle,
    pub db: Arc<Db>,
    pub vault: Arc<Vault>,
    pub prompts: Prompts,
    pub pool: Pool,
    pub terms: Terms,
    pub monitors: Monitors,
    pub tunnels: Tunnels,
    pub transfers: Transfers,
    pub indexes: crate::predict::Indexes,
}

pub type CtxRef = Arc<Ctx>;
