//! Encrypted credential store.
//!
//! master password --Argon2id--> KEK --XChaCha20-Poly1305--> wraps a random 32-byte data key.
//! Every secret (password, private key, API key) is encrypted with the data key. Only ciphertext
//! touches disk, so cloud sync can upload the `secrets` table as-is (end-to-end encrypted).
//! "Remember on this device" stores the data key protected by Windows DPAPI (current user only).

use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use parking_lot::RwLock;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::db::Db;
use crate::util::new_id;

const META_SALT: &str = "salt";
const META_WRAPPED: &str = "wrapped_key";
const META_DPAPI: &str = "dpapi_key";

pub struct Vault {
    db: Arc<Db>,
    key: RwLock<Option<Zeroizing<[u8; 32]>>>,
}

pub(crate) fn derive_kek(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| anyhow!("{e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| anyhow!("{e}"))?;
    Ok(out)
}

pub(crate) fn seal(key: &[u8; 32], plain: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(&XNonce::from(nonce), plain)
        .map_err(|_| anyhow!("加密失败"))?;
    Ok((nonce.to_vec(), ct))
}

pub(crate) fn open(key: &[u8; 32], nonce: &[u8], ct: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if nonce.len() != 24 {
        bail!("密文格式错误");
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let n: [u8; 24] = nonce.try_into()?;
    let pt = cipher
        .decrypt(&XNonce::from(n), ct)
        .map_err(|_| anyhow!("解密失败"))?;
    Ok(Zeroizing::new(pt))
}

fn pack(nonce: &[u8], ct: &[u8]) -> Vec<u8> {
    [nonce, ct].concat()
}

fn unpack(b: &[u8]) -> Result<(&[u8], &[u8])> {
    if b.len() < 24 {
        bail!("密文格式错误");
    }
    Ok(b.split_at(24))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub remembered: bool,
}

impl Vault {
    pub fn new(db: Arc<Db>) -> Self {
        let v = Self { db, key: RwLock::new(None) };
        // Auto-unlock if this device remembered the key.
        let _ = v.try_dpapi_unlock();
        v
    }

    pub fn status(&self) -> Result<VaultStatus> {
        Ok(VaultStatus {
            initialized: self.db.meta_get(META_WRAPPED)?.is_some(),
            unlocked: self.key.read().is_some(),
            remembered: self.db.meta_get(META_DPAPI)?.is_some(),
        })
    }

    pub fn setup(&self, password: &str, remember: bool) -> Result<()> {
        if self.db.meta_get(META_WRAPPED)?.is_some() {
            bail!("保险库已初始化");
        }
        if password.chars().count() < 8 {
            bail!("主密码至少 8 位");
        }
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let mut data_key = Zeroizing::new([0u8; 32]);
        rand::thread_rng().fill_bytes(data_key.as_mut());
        let kek = derive_kek(password, &salt)?;
        let (n, ct) = seal(&kek, data_key.as_ref())?;
        self.db.meta_set(META_SALT, &salt)?;
        self.db.meta_set(META_WRAPPED, &pack(&n, &ct))?;
        *self.key.write() = Some(data_key);
        if remember {
            self.remember(true)?;
        }
        Ok(())
    }

    pub fn unlock(&self, password: &str, remember: bool) -> Result<()> {
        let salt = self.db.meta_get(META_SALT)?.ok_or_else(|| anyhow!("保险库未初始化"))?;
        let wrapped = self.db.meta_get(META_WRAPPED)?.ok_or_else(|| anyhow!("保险库未初始化"))?;
        let kek = derive_kek(password, &salt)?;
        let (n, ct) = unpack(&wrapped)?;
        let pt = open(&kek, n, ct).map_err(|_| anyhow!("主密码错误"))?;
        let mut k = Zeroizing::new([0u8; 32]);
        k.copy_from_slice(&pt);
        *self.key.write() = Some(k);
        if remember {
            self.remember(true)?;
        }
        Ok(())
    }

    pub fn change_password(&self, old: &str, new: &str) -> Result<()> {
        self.unlock(old, false)?;
        if new.chars().count() < 8 {
            bail!("主密码至少 8 位");
        }
        let key = self.data_key()?;
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let kek = derive_kek(new, &salt)?;
        let (n, ct) = seal(&kek, key.as_ref())?;
        self.db.meta_set(META_SALT, &salt)?;
        self.db.meta_set(META_WRAPPED, &pack(&n, &ct))?;
        Ok(())
    }

    pub fn lock(&self) {
        *self.key.write() = None;
    }

    pub fn remember(&self, on: bool) -> Result<()> {
        if !on {
            return self.db.meta_del(META_DPAPI);
        }
        let key = self.data_key()?;
        let blob = dpapi::protect(key.as_ref())?;
        self.db.meta_set(META_DPAPI, &blob)
    }

    fn try_dpapi_unlock(&self) -> Result<()> {
        let blob = self.db.meta_get(META_DPAPI)?.ok_or_else(|| anyhow!("none"))?;
        let pt = dpapi::unprotect(&blob)?;
        if pt.len() != 32 {
            bail!("bad key");
        }
        let mut k = Zeroizing::new([0u8; 32]);
        k.copy_from_slice(&pt);
        *self.key.write() = Some(k);
        Ok(())
    }

    fn data_key(&self) -> Result<Zeroizing<[u8; 32]>> {
        self.key.read().clone().ok_or_else(|| anyhow!("保险库已锁定，请先解锁"))
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.read().is_some()
    }

    /// Store a secret; reuses `id` when given (update), otherwise creates one.
    pub fn put(&self, id: Option<&str>, plain: &str) -> Result<String> {
        let key = self.data_key()?;
        let id = id.map(str::to_string).unwrap_or_else(new_id);
        let (n, ct) = seal(&key, plain.as_bytes())?;
        self.db.put_secret_raw(&id, &n, &ct)?;
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Result<Zeroizing<String>> {
        let key = self.data_key()?;
        let (n, ct) = self.db.get_secret_raw(id)?;
        let pt = open(&key, &n, &ct)?;
        Ok(Zeroizing::new(String::from_utf8(pt.to_vec())?))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.db.delete_secret(id)
    }
}

#[cfg(windows)]
mod dpapi {
    use anyhow::{Result, bail};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    const ENTROPY: &[u8] = b"myshellplus-vault-v1";

    fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
        let input = blob(data);
        let ent = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(&input, std::ptr::null(), &ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            bail!("DPAPI 加密失败");
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }

    pub fn unprotect(data: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        let input = blob(data);
        let ent = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), &ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            bail!("DPAPI 解密失败");
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe {
            std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
            LocalFree(out.pbData as _);
        }
        Ok(zeroize::Zeroizing::new(v))
    }
}

#[cfg(not(windows))]
mod dpapi {
    // Android/other platforms will use the platform keystore; not implemented yet.
    use anyhow::{Result, bail};
    pub fn protect(_: &[u8]) -> Result<Vec<u8>> {
        bail!("当前平台不支持记住密码")
    }
    pub fn unprotect(_: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>> {
        bail!("当前平台不支持记住密码")
    }
}
