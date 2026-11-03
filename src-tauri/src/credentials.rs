//! Shared on-disk secret storage for the Rust/Tauri host.
//!
//! This is the Rust mirror of `scripts/lib/credentials.js`, which is the
//! canonical implementation of the format. The Electron, Go/Wails and
//! C#/WinUI hosts implement the same on-disk layout, so a user data directory
//! can be moved between hosts without losing the database credentials or the
//! provider-API-key encryption key.
//!
//! # Security model
//!
//! A fixed `root`/`root` credential on a loopback-bound service is not a
//! defense: any other process or account on the machine can reach the local
//! port and read the whole notebook database. Each install therefore gets its
//! own randomly generated database password.
//!
//! Secrets are stored obfuscated (XOR with a machine-and-user-bound
//! derivation) rather than in plaintext, and the files are restricted to the
//! current OS user via ACLs. This is deliberately not presented as equivalent
//! to a hardware-backed key store; it raises the bar against casual reads by
//! other processes. It does not defend against an attacker who already runs
//! as the current user.
//!
//! # Legacy installs
//!
//! SurrealDB applies the initial root credentials *only when no root user
//! exists yet*. A datastore created by an older build already has a root
//! user, so a newly generated password has no effect and the backend would
//! be locked out of its own data. Existing datastores therefore keep their
//! original `root` password; only fresh installs receive a random one.
//!
//! # Cross-language on-disk contract
//!
//! These details are byte-for-byte identical in the JavaScript, Go and C#
//! hosts and must not drift:
//!
//! * Obfuscation key: `SHA-256("Office-Equity-Open-Notebook|<username>|<hostname>")`
//!   over the UTF-8 joined string, with the domain qualifier stripped from
//!   the user name.
//! * Obfuscated value: `obf:` followed by standard base64 of
//!   `XOR(utf8(secret), key)`.
//! * `encryption-key.txt`: the obfuscated 32-byte key, hex encoded.
//! * `secrets.json`: `{"surrealPassword": "<value>"}`, two-space indent and
//!   a trailing newline.
//! * Legacy values without the `obf:` prefix are plaintext and are returned
//!   unchanged.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// File holding the obfuscated provider-API-key encryption key.
pub const KEY_FILENAME: &str = "encryption-key.txt";
/// File holding the obfuscated SurrealDB root password.
pub const SECRETS_FILENAME: &str = "secrets.json";
/// The root password used by builds that predate per-install credentials.
pub const LEGACY_DATABASE_PASSWORD: &str = "root";
/// The SurrealDB root username. Fixed, because it is not itself a secret.
pub const DATABASE_USER: &str = "root";

/// Directory and file names of the SurrealDB datastore, relative to the data dir.
pub const DATABASE_DIRNAME: &str = "surrealdb";
pub const DATABASE_FILENAME: &str = "mydatabase.db";

/// Marker prefix identifying an obfuscated value in a secret file.
pub const OBFUSCATION_PREFIX: &str = "obf:";
/// App-specific salt mixed into the obfuscation key derivation.
pub const OBFUSCATION_SALT: &str = "Office-Equity-Open-Notebook";

/// Length in bytes of the generated encryption key.
pub const ENCRYPTION_KEY_BYTES: usize = 32;
/// Length in bytes of the generated database password.
pub const DATABASE_PASSWORD_BYTES: usize = 24;

/// Where the resolved database password came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    /// The install predates per-install credentials and keeps `root`/`root`.
    Legacy,
    /// The password was read back from an existing secret store.
    Stored,
    /// The password was generated on this run.
    Generated,
}

/// The SurrealDB credentials to start the database with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseCredentials {
    /// The SurrealDB user name.
    pub user: String,
    /// The SurrealDB password.
    pub password: String,
    /// True when the install still uses the legacy `root`/`root` credential.
    pub legacy: bool,
    /// Where the password came from.
    pub source: CredentialSource,
}

/// The environment variables that carry database credentials to the
/// SurrealDB server and the Python backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialEnvironment {
    /// `SURREAL_USER`, read by both SurrealDB and the upstream backend.
    pub surreal_user: String,
    /// `SURREAL_PASSWORD`, read by the upstream backend.
    pub surreal_password: String,
    /// `SURREAL_PASS`, read by the SurrealDB CLI.
    pub surreal_pass: String,
}

impl CredentialEnvironment {
    /// Renders the environment as `(name, value)` pairs.
    pub fn as_pairs(&self) -> Vec<(&'static str, &str)> {
        vec![
            ("SURREAL_USER", self.surreal_user.as_str()),
            ("SURREAL_PASSWORD", self.surreal_password.as_str()),
            ("SURREAL_PASS", self.surreal_pass.as_str()),
        ]
    }
}

/// Strips a domain qualifier from an account name.
///
/// Windows APIs disagree about whether the account name is domain-qualified:
/// `GetUserNameW` reports `cruzmars` while Go's `user.Current()` reports
/// `UNIVERSITY\cruzmars`. The obfuscation key has to be identical across all
/// hosts, so the domain qualifier is removed everywhere.
pub fn strip_user_domain(name: &str) -> String {
    let raw = name.trim();
    if raw.is_empty() {
        return String::new();
    }
    let cut = raw.rfind('\\').into_iter().chain(raw.rfind('/')).max();
    match cut {
        Some(index) => raw[index + 1..].trim().to_string(),
        None => raw.to_string(),
    }
}

/// The current OS user name, or an empty string when it cannot be determined.
///
/// The environment is consulted first because every host can read it, whereas
/// the OS account APIs differ in what they return. The order is fixed so that
/// all hosts resolve the same value: `USERNAME`, then `USER`, then the OS
/// account API.
pub fn current_username() -> String {
    for key in ["USERNAME", "USER"] {
        if let Ok(value) = std::env::var(key) {
            let stripped = strip_user_domain(&value);
            if !stripped.is_empty() {
                return stripped;
            }
        }
    }
    fallback_username()
}

/// The current machine name, or an empty string when it cannot be determined.
///
/// The order is fixed so that all hosts resolve the same value:
/// `COMPUTERNAME`, then `HOSTNAME`, then the OS API.
pub fn current_hostname() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    fallback_hostname()
}

/// Best-effort user name from the OS account API.
fn fallback_username() -> String {
    use sysinfo::{System, SystemExt, UserExt};
    let mut system = System::new();
    system.refresh_users_list();
    for user in system.users() {
        let stripped = strip_user_domain(user.name());
        if !stripped.is_empty() {
            return stripped;
        }
    }
    String::new()
}

/// Best-effort machine name from the OS API.
fn fallback_hostname() -> String {
    use sysinfo::{System, SystemExt};
    let mut system = System::new();
    system.refresh_system();
    system
        .host_name()
        .map(|name| name.trim().to_string())
        .unwrap_or_default()
}

/// Derives the obfuscation key for the current account and machine.
pub fn derive_obfuscation_key() -> [u8; 32] {
    derive_obfuscation_key_from(&current_username(), &current_hostname())
}

/// Derives the obfuscation key for an explicit account and machine name.
///
/// Exposed so that the cross-language parity tests can check a fixed vector
/// instead of depending on the machine the tests happen to run on.
pub fn derive_obfuscation_key_from(username: &str, hostname: &str) -> [u8; 32] {
    let joined = format!("{}|{}|{}", OBFUSCATION_SALT, username, hostname);
    let digest = Sha256::digest(joined.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// XOR-obfuscates data with the machine-bound key.
///
/// The transform is symmetric: applying it twice restores the original bytes.
pub fn xor_obfuscate(data: &[u8], key: &[u8]) -> Vec<u8> {
    if key.is_empty() {
        return data.to_vec();
    }
    data.iter()
        .enumerate()
        .map(|(index, byte)| byte ^ key[index % key.len()])
        .collect()
}

/// Obfuscates a secret and encodes it for storage.
pub fn encode_secret_with(secret: &str, key: &[u8]) -> String {
    let obfuscated = xor_obfuscate(secret.as_bytes(), key);
    format!("{}{}", OBFUSCATION_PREFIX, STANDARD.encode(obfuscated))
}

/// Decodes a stored secret value against an explicit key.
///
/// Values written before the obfuscated format existed are stored in
/// plaintext and are returned unchanged, so existing installs keep working.
pub fn decode_secret_with(stored: &str, key: &[u8]) -> String {
    let raw = stored.trim();
    let Some(encoded) = raw.strip_prefix(OBFUSCATION_PREFIX) else {
        return raw.to_string();
    };
    let Ok(obfuscated) = STANDARD.decode(encoded) else {
        return raw.to_string();
    };
    String::from_utf8_lossy(&xor_obfuscate(&obfuscated, key)).into_owned()
}

/// Obfuscates a secret with the machine-bound key and encodes it.
pub fn encode_secret(secret: &str) -> String {
    encode_secret_with(secret, &derive_obfuscation_key())
}

/// Decodes a stored secret value with the machine-bound key.
pub fn decode_secret(stored: &str) -> String {
    decode_secret_with(stored, &derive_obfuscation_key())
}

/// Restricts a file to the current OS user.
///
/// This is best effort by design: a failure here must never stop the app
/// from starting, so every error is swallowed.
pub fn restrict_to_current_user(file: &Path) -> bool {
    #[cfg(windows)]
    {
        let user = match std::env::var("USERNAME") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => return false,
        };
        let grant = format!("{}:F", user);
        std::process::Command::new("icacls")
            .arg(file)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(&grant)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600)).is_ok()
    }
}

/// Writes `contents` to `file` and restricts it to the current OS user.
fn write_secret_file(file: &Path, contents: &str) {
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::write(file, contents.as_bytes()).is_ok() {
        restrict_to_current_user(file);
    }
}

/// Writes the encryption key, obfuscated, to `file`.
fn write_encryption_key_file(file: &Path, key: &str) {
    write_secret_file(file, &encode_secret(key));
}

/// Reads the encryption key from `file`.
fn read_encryption_key_file(file: &Path) -> String {
    match fs::read_to_string(file) {
        Ok(contents) => decode_secret(&contents),
        Err(_) => String::new(),
    }
}

/// True when `data_dir` already holds a SurrealDB datastore from an earlier run.
///
/// RocksDB stores its datastore in a directory, which reports a size of 0 on
/// Windows, so both shapes have to be checked.
pub fn has_existing_datastore(data_dir: &Path) -> bool {
    let file = data_dir.join(DATABASE_DIRNAME).join(DATABASE_FILENAME);
    match fs::metadata(&file) {
        Ok(metadata) => {
            if metadata.is_dir() {
                fs::read_dir(&file)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(false)
            } else {
                metadata.len() > 0
            }
        }
        Err(_) => false,
    }
}

/// Generates a random base64url password.
fn random_password() -> String {
    let mut bytes = [0u8; DATABASE_PASSWORD_BYTES];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Fall back to a time-seeded value rather than failing startup.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut state = nanos as u64 ^ ((std::process::id() as u64) << 32);
        for byte in bytes.iter_mut() {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *byte = (state >> 33) as u8;
        }
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Returns the persisted database password for `data_dir`, generating one on
/// first use.
pub fn ensure_database_password(data_dir: &Path) -> String {
    let secrets_file = data_dir.join(SECRETS_FILENAME);
    if let Ok(contents) = fs::read_to_string(&secrets_file) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(stored) = parsed.get("surrealPassword").and_then(|v| v.as_str()) {
                if !stored.is_empty() {
                    return decode_secret(stored);
                }
            }
        }
        // A corrupt secrets file is rewritten below rather than crashing startup.
    }

    let password = random_password();
    write_secret_file(
        &secrets_file,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({
                "surrealPassword": encode_secret(&password),
            }))
            .unwrap_or_default()
        ),
    );
    password
}

/// Resolves the SurrealDB credentials to start the database with.
///
/// SurrealDB applies the initial root credentials only when no root user
/// exists yet, so a freshly generated password has no effect on a datastore
/// created by an older build: the stored root credentials win and the backend
/// would be locked out of its own data. Existing datastores therefore keep
/// their original password so upgrades never lose notebook content; only new
/// installs get a random one.
pub fn resolve_database_credentials(data_dir: &Path) -> DatabaseCredentials {
    let secrets_file = data_dir.join(SECRETS_FILENAME);
    let had_secrets = secrets_file.exists();
    if has_existing_datastore(data_dir) && !had_secrets {
        return DatabaseCredentials {
            user: DATABASE_USER.to_string(),
            password: LEGACY_DATABASE_PASSWORD.to_string(),
            legacy: true,
            source: CredentialSource::Legacy,
        };
    }
    let password = ensure_database_password(data_dir);
    DatabaseCredentials {
        user: DATABASE_USER.to_string(),
        password,
        legacy: false,
        source: if had_secrets {
            CredentialSource::Stored
        } else {
            CredentialSource::Generated
        },
    }
}

/// Returns the persisted encryption key for `data_dir`, generating a random
/// 32-byte key on first use.
///
/// The key is stored obfuscated so it never appears in plaintext on disk.
/// Legacy plaintext key files are still readable, but new keys use the
/// obfuscated format.
pub fn ensure_encryption_key(data_dir: &Path) -> String {
    let key_file = data_dir.join(KEY_FILENAME);
    if key_file.exists() {
        let existing = read_encryption_key_file(&key_file);
        if !existing.is_empty() {
            return existing;
        }
    }
    let mut bytes = [0u8; ENCRYPTION_KEY_BYTES];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut state = nanos as u64;
        for byte in bytes.iter_mut() {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *byte = (state >> 33) as u8;
        }
    }
    let key = bytes
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>();
    write_encryption_key_file(&key_file, &key);
    key
}

/// Builds the environment variables that carry the database credentials to the
/// SurrealDB server and the Python backend.
///
/// SurrealDB's own CLI reads `SURREAL_USER` and `SURREAL_PASS`. The upstream
/// backend reads `SURREAL_USER` and `SURREAL_PASSWORD`, falling back to
/// `SURREAL_PASS`. Both are therefore set to the same value.
///
/// The credentials are passed through the process environment rather than the
/// command line so they never appear in the process listing.
pub fn build_credential_environment(credentials: &DatabaseCredentials) -> CredentialEnvironment {
    CredentialEnvironment {
        surreal_user: credentials.user.clone(),
        surreal_password: credentials.password.clone(),
        surreal_pass: credentials.password.clone(),
    }
}

/// The user data directory used by the Tauri host.
pub fn default_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OfficeEquityOpenNotebook")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared cross-language fixture. Kept in step with the JavaScript,
    /// Go and C# hosts by `tests/contracts/credentials-cases.json`.
    const CASES: &str = include_str!("../../tests/contracts/credentials-cases.json");

    /// Reads a flat string value out of the fixture.
    fn case_value(cases: &str, name: &str) -> String {
        let needle = format!("\"{}\"", name);
        let start = cases.find(&needle).expect("fixture case") + needle.len();
        let rest = &cases[start..];
        let colon = rest.find(':').expect("fixture value") + 1;
        let rest = rest[colon..].trim_start();
        let end = rest.find(|c| c == ',' || c == '\n').unwrap_or(rest.len());
        rest[..end].trim().trim_matches('"').to_string()
    }

    #[test]
    fn strips_domain_qualifier() {
        assert_eq!(strip_user_domain("UNIVERSITY\\cruzmars"), "cruzmars");
        assert_eq!(strip_user_domain("DOMAIN/user"), "user");
        assert_eq!(strip_user_domain("plain"), "plain");
        assert_eq!(strip_user_domain(""), "");
        assert_eq!(strip_user_domain("   "), "");
    }

    #[test]
    fn derivation_matches_shared_vectors() {
        let expected = [
            (
                "testuser",
                "testhost",
                "b1189a3224e146d49f8249f1a53a7c62bbebeaa9d9f2eccea151e08a0588fe93",
            ),
            (
                "cruzmars",
                "AMC-5RCSFW3",
                "6a150e433a47f44192134ce516e9ffbefabc0bc4b465141a382247dc3dd14396",
            ),
        ];
        for (username, hostname, hex) in expected {
            let key = derive_obfuscation_key_from(username, hostname);
            let encoded: String = key.iter().map(|byte| format!("{:02x}", byte)).collect();
            assert_eq!(encoded, hex, "derivation vector for {username}");
        }
    }

    #[test]
    fn obfuscation_matches_shared_vectors() {
        let key = derive_obfuscation_key_from("testuser", "testhost");
        let expected = case_value(CASES, "encodedSecret");
        assert_eq!(encode_secret_with("s3cr3t-db-password", &key), expected);
    }

    #[test]
    fn obfuscation_round_trips() {
        let key = derive_obfuscation_key_from("testuser", "testhost");
        let encoded = encode_secret_with("s3cr3t-db-password", &key);
        assert_eq!(decode_secret_with(&encoded, &key), "s3cr3t-db-password");
    }

    #[test]
    fn legacy_plaintext_is_returned_unchanged() {
        let key = derive_obfuscation_key_from("testuser", "testhost");
        assert_eq!(
            decode_secret_with("plaintext-legacy", &key),
            "plaintext-legacy"
        );
    }

    #[test]
    fn xor_is_symmetric() {
        let key = derive_obfuscation_key_from("testuser", "testhost");
        let data = b"the quick brown fox";
        let once = xor_obfuscate(data, &key);
        assert_ne!(once, data.to_vec());
        assert_eq!(xor_obfuscate(&once, &key), data.to_vec());
    }

    #[test]
    fn fresh_install_generates_a_random_password() {
        let dir = tempdir("fresh");
        let credentials = resolve_database_credentials(&dir);
        assert_eq!(credentials.user, DATABASE_USER);
        assert!(!credentials.legacy);
        assert_eq!(credentials.source, CredentialSource::Generated);
        assert!(!credentials.password.is_empty());

        let secrets = fs::read_to_string(dir.join(SECRETS_FILENAME)).expect("secrets file");
        assert!(secrets.contains(OBFUSCATION_PREFIX));
        assert!(!secrets.contains(&credentials.password));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_datastore_keeps_the_legacy_password() {
        let dir = tempdir("legacy");
        let db = dir.join(DATABASE_DIRNAME).join(DATABASE_FILENAME);
        fs::create_dir_all(&db).expect("datastore dir");
        fs::write(db.join("CURRENT"), b"x").expect("datastore file");

        let credentials = resolve_database_credentials(&dir);
        assert_eq!(credentials.password, LEGACY_DATABASE_PASSWORD);
        assert!(credentials.legacy);
        assert_eq!(credentials.source, CredentialSource::Legacy);
        assert!(!dir.join(SECRETS_FILENAME).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stored_password_survives_a_restart() {
        let dir = tempdir("restart");
        let first = resolve_database_credentials(&dir);
        let second = resolve_database_credentials(&dir);
        assert_eq!(first.password, second.password);
        assert_eq!(second.source, CredentialSource::Stored);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_secrets_file_is_regenerated() {
        let dir = tempdir("corrupt");
        fs::write(dir.join(SECRETS_FILENAME), "{not json").expect("corrupt file");
        let credentials = resolve_database_credentials(&dir);
        assert!(!credentials.password.is_empty());
        assert!(!credentials.legacy);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn encryption_key_is_stable_and_obfuscated_at_rest() {
        let dir = tempdir("key");
        let first = ensure_encryption_key(&dir);
        let second = ensure_encryption_key(&dir);
        assert_eq!(first, second);
        assert_eq!(first.len(), ENCRYPTION_KEY_BYTES * 2);

        let stored = fs::read_to_string(dir.join(KEY_FILENAME)).expect("key file");
        assert!(stored.starts_with(OBFUSCATION_PREFIX));
        assert!(!stored.contains(&first));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn credential_environment_carries_the_password() {
        let environment = build_credential_environment(&DatabaseCredentials {
            user: DATABASE_USER.to_string(),
            password: "s3cr3t".to_string(),
            legacy: false,
            source: CredentialSource::Generated,
        });
        assert_eq!(environment.surreal_user, DATABASE_USER);
        assert_eq!(environment.surreal_password, "s3cr3t");
        assert_eq!(environment.surreal_pass, "s3cr3t");
    }

    /// Creates a unique temporary directory for a test.
    fn tempdir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "oen-credentials-{label}-{}-{}",
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }
}
