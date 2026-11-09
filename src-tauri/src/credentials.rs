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
//! Existing datastores with missing credentials require explicit recovery.
//! Startup never assumes a legacy password or replaces a damaged secret: a
//! datastore without a `secrets.json` is reported as
//! [`CredentialSource::LegacyUnmigrated`] with no password, so the caller has
//! to run the migration instead of quietly connecting as `root`.
//!
//! The migration itself is owned by `scripts/lib/credential-migration.js`, which
//! probes the datastore with the historical password once, rotates it, and only
//! then persists it. This host deliberately carries no copy of that probe
//! password: a second copy would be a second thing to forget to remove.
//!
//! Obfuscation does not authenticate stored values, so some corruption cannot
//! be detected without changing the shared on-disk format.
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
    /// A datastore exists but `secrets.json` does not: the install predates
    /// per-install credentials and needs an explicit migration.
    LegacyUnmigrated,
    /// The password was read back from an existing secret store.
    Stored,
    /// The password was generated on this run.
    Generated,
    /// The password was provisioned by rotating a legacy datastore to a
    /// per-install credential.
    ///
    /// This describes the migration that produced the password, not the state of
    /// a later launch: once the password is persisted, later resolutions report
    /// [`CredentialSource::Stored`].
    Migrated,
}

/// The SurrealDB credentials to start the database with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseCredentials {
    /// The SurrealDB user name.
    pub user: String,
    /// The SurrealDB password, absent until the install has been migrated.
    pub password: Option<String>,
    /// True when the install still needs credential migration.
    pub migration_required: bool,
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
pub fn restrict_to_current_user(file: &Path) -> bool {
    #[cfg(windows)]
    {
        let user = match std::env::var("USERNAME") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => return false,
        };
        let status = std::process::Command::new("icacls")
            .arg(file).arg("/inheritance:r").arg("/grant:r")
            .arg(format!("{}:F", user))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().map(|status| status.success()).unwrap_or(false);
        status && check_restricted_to_current_user(file)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600)).is_ok()
            && check_restricted_to_current_user(file)
    }
}

/// Returns whether `file` is provably readable only by the current OS user.
///
/// The restriction is verified rather than assumed: `icacls` can report success
/// while a second ACE (an explicit grant, or an inherited one the command did
/// not remove) still exposes the secret, and a POSIX mode can be widened again
/// after the fact.
pub fn check_restricted_to_current_user(file: &Path) -> bool {
    #[cfg(windows)]
    {
        let output = match std::process::Command::new("icacls").arg(file).output() {
            Ok(output) if output.status.success() => output,
            _ => return false,
        };
        let listing = String::from_utf8_lossy(&output.stdout);
        is_restricted_acl_listing(&listing)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        match fs::metadata(file) {
            Ok(metadata) => is_restricted_posix_mode(metadata.permissions().mode() & 0o777),
            Err(_) => false,
        }
    }
}

/// Classifies `icacls` output as owner-only or not.
///
/// `icacls` interleaves diagnostics (`Successfully processed …`, an unresolved
/// domain trust, a mandatory-integrity label) with the ACL itself, so the ACE
/// lines are isolated before counting. Exactly one non-inherited full-control
/// ACE for a single principal is the only accepted shape.
pub fn is_restricted_acl_listing(listing: &str) -> bool {
    let aces: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !line.starts_with("Successfully processed")
                && !line.starts_with("Failed processing")
                && !line.starts_with("The trust relationship")
                && !line.starts_with("Mandatory Label")
        })
        .collect();
    if aces.len() != 1 {
        return false;
    }
    let ace = aces[0];
    !ace.contains("(I)") && ace.ends_with("(F)")
}

/// True when a POSIX mode grants nothing to group or other.
pub fn is_restricted_posix_mode(mode: u32) -> bool {
    mode & 0o077 == 0
}

fn protected_read(file: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(file) {
        Ok(contents) => {
            // Verified, not repaired. A file that other accounts can read may
            // already have exposed the secret, and silently tightening the ACL
            // would hide that from the user.
            if !check_restricted_to_current_user(file) {
                return Err("Credential file permissions are too open".into());
            }
            Ok(Some(contents))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read credential file".into()),
    }
}

fn protected_write(file: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = file.parent().ok_or("Invalid credential path")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create credential directory")?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(file).map_err(|_| "Could not create credential file")?;
    if !restrict_to_current_user(file) {
        return Err("Could not restrict credential file permissions".into());
    }
    output.write_all(contents.as_bytes()).map_err(|_| "Could not write credential file")?;
    output.sync_all().map_err(|_| "Could not persist credential file")?;
    Ok(())
}

fn decode_checked(stored: &str) -> Result<String, String> {
    let raw = stored.trim();
    let decoded = if let Some(encoded) = raw.strip_prefix(OBFUSCATION_PREFIX) {
        let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid encoded credential")?;
        String::from_utf8(xor_obfuscate(&bytes, &derive_obfuscation_key()))
            .map_err(|_| "Invalid credential encoding")?
    } else {
        raw.to_string()
    };
    if decoded.is_empty() || decoded.chars().any(|c| c.is_control()) {
        return Err("Invalid credential value".into());
    }
    Ok(decoded)
}

/// Returns whether a datastore exists, failing closed on inspection errors.
///
/// Both the datastore file and its directory have to be inspected: a directory
/// that exists but cannot be listed hides a legacy datastore just as
/// effectively as an unreadable file does, and reporting "fresh install" for an
/// unreadable datastore would overwrite the credentials of an install that
/// still works.
pub fn has_existing_datastore(data_dir: &Path) -> Result<bool, String> {
    let dir = data_dir.join(DATABASE_DIRNAME);
    let file = dir.join(DATABASE_FILENAME);
    match fs::metadata(&file) {
        Ok(metadata) if metadata.is_dir() => {
            let mut entries = fs::read_dir(&file).map_err(|_| "Could not inspect datastore")?;
            match entries.next() {
                Some(Ok(_)) => Ok(true),
                Some(Err(_)) => Err("Could not inspect datastore".into()),
                None => Ok(false),
            }
        }
        Ok(metadata) => Ok(metadata.len() > 0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fs::read_dir(&dir) {
            Ok(_) => Ok(false),
            Err(dir_error) if dir_error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("Could not inspect datastore".into()),
        },
        Err(_) => Err("Could not inspect datastore".into()),
    }
}

fn random_password() -> Result<String, String> {
    let mut bytes = [0u8; DATABASE_PASSWORD_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|_| "Secure random generator failed")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Reads an existing password or securely creates one for a new datastore.
pub fn ensure_database_password(data_dir: &Path) -> Result<String, String> {
    let file = data_dir.join(SECRETS_FILENAME);
    if let Some(contents) = protected_read(&file)? {
        let parsed: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|_| "Invalid database credential file")?;
        let stored = parsed.get("surrealPassword").and_then(|v| v.as_str())
            .ok_or("Invalid database credential file")?;
        return decode_checked(stored);
    }
    if has_existing_datastore(data_dir)? {
        return Err("Existing datastore has no credential file; recovery is required".into());
    }
    let password = random_password()?;
    let contents = serde_json::to_string_pretty(&serde_json::json!({
        "surrealPassword": encode_secret(&password),
    })).map_err(|_| "Could not serialize database credential")? + "\n";
    protected_write(&file, &contents)?;
    Ok(password)
}

pub fn resolve_database_credentials(data_dir: &Path) -> Result<DatabaseCredentials, String> {
    let existed = match fs::metadata(data_dir.join(SECRETS_FILENAME)) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Could not inspect database credential file".into()),
    };
    if !existed && has_existing_datastore(data_dir)? {
        // The datastore predates per-install credentials. Report the state
        // instead of inventing a password: SurrealDB ignores initial
        // credentials for a datastore that already has a root user, so any
        // password generated here would lock the backend out.
        return Ok(DatabaseCredentials {
            user: DATABASE_USER.to_string(),
            password: None,
            migration_required: true,
            source: CredentialSource::LegacyUnmigrated,
        });
    }
    let password = ensure_database_password(data_dir)?;
    Ok(DatabaseCredentials {
        user: DATABASE_USER.to_string(), password: Some(password), migration_required: false,
        source: if existed { CredentialSource::Stored } else { CredentialSource::Generated },
    })
}

pub fn ensure_encryption_key(data_dir: &Path) -> Result<String, String> {
    let file = data_dir.join(KEY_FILENAME);
    if let Some(contents) = protected_read(&file)? {
        let key = decode_checked(&contents)?;
        if key.len() != ENCRYPTION_KEY_BYTES * 2 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid encryption key".into());
        }
        return Ok(key);
    }
    if has_existing_datastore(data_dir)? {
        return Err("Existing datastore has no encryption key; recovery is required".into());
    }
    let mut bytes = [0u8; ENCRYPTION_KEY_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|_| "Secure random generator failed")?;
    let key: String = bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
    protected_write(&file, &encode_secret(&key))?;
    Ok(key)
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
///
/// A `LegacyUnmigrated` install has no password yet, so this is fallible rather
/// than defaulting to a usable value: inheriting `root` here is what let every
/// host connect to a pre-existing datastore without anyone noticing.
pub fn build_credential_environment(
    credentials: &DatabaseCredentials,
) -> Result<CredentialEnvironment, String> {
    let password = credentials
        .password
        .as_deref()
        .ok_or("Database credentials have not been provisioned; recovery is required")?;
    if password.is_empty() || password.chars().any(|c| c.is_control()) {
        return Err("Invalid credential value".into());
    }
    Ok(CredentialEnvironment {
        surreal_user: credentials.user.clone(),
        surreal_password: password.to_string(),
        surreal_pass: password.to_string(),
    })
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

    /// Parses the shared fixture.
    fn cases() -> serde_json::Value {
        serde_json::from_str(CASES).expect("fixture is valid JSON")
    }

    /// Maps an internal failure message onto the shared error-code vocabulary.
    ///
    /// The Rust API carries operator-facing messages rather than codes, so the
    /// contract is asserted through this table: it is the single place where a
    /// message change has to be reconciled with the fixture.
    fn error_code(message: &str) -> &'static str {
        match message {
            "Credential file permissions are too open" => "permissions-too-open",
            "Could not inspect datastore"
            | "The datastore exists but could not be reached to migrate its credentials"
            | "The datastore exists but could not be reached to complete its credential migration"
            | "The datastore exists but no database connection was supplied to migrate its credentials" => {
                "datastore-unreadable"
            }
            "The existing datastore does not accept the legacy credential; an operator must supply its current password"
            | "Credential rotation failed; the existing datastore is unchanged" => "migration-rejected",
            "Invalid database credential file"
            | "Existing datastore has no credential file; recovery is required" => {
                "invalid-secrets-file"
            }
            "Invalid encoded credential"
            | "Invalid credential encoding"
            | "Invalid credential value"
            | "Invalid encryption key"
            | "Database credentials have not been provisioned; recovery is required" => {
                "invalid-secret-value"
            }
            other => panic!("unmapped credential failure: {other}"),
        }
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
        let cases = cases();
        let vectors = cases["derivationVectors"].as_array().expect("derivation vectors");
        assert_eq!(vectors.len(), 4, "every shared derivation vector is checked");
        for vector in vectors {
            let username = vector["username"].as_str().expect("username");
            let hostname = vector["hostname"].as_str().expect("hostname");
            let hex = vector["keyHex"].as_str().expect("keyHex");
            let key = derive_obfuscation_key_from(username, hostname);
            let encoded: String = key.iter().map(|byte| format!("{:02x}", byte)).collect();
            assert_eq!(encoded, hex, "derivation vector for {username}|{hostname}");
        }
    }

    #[test]
    fn obfuscation_matches_shared_vectors() {
        let cases = cases();
        let key = derive_obfuscation_key_from(
            cases["encodedSecretKeyUsername"].as_str().expect("username"),
            cases["encodedSecretKeyHostname"].as_str().expect("hostname"),
        );
        let expected = cases["encodedSecret"].as_str().expect("encodedSecret");
        let plaintext = cases["encodedSecretPlaintext"].as_str().expect("plaintext");
        assert_eq!(encode_secret_with(plaintext, &key), expected);
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
        let plaintext = cases()["legacyPlaintextSecret"].as_str().expect("legacy plaintext").to_string();
        assert_eq!(decode_secret_with(&plaintext, &key), plaintext);
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
    fn acl_listings_are_classified_like_every_other_host() {
        let cases = cases();
        let samples = cases["aclSamples"].as_array().expect("acl samples");
        assert!(samples.len() >= 10, "every shared ACL sample is checked");
        for sample in samples {
            let id = sample["id"].as_str().expect("sample id");
            let expected = sample["restricted"].as_bool().expect("restricted");
            let actual = match sample["platform"].as_str().expect("platform") {
                "windows" => {
                    let listing = sample["icaclsOutput"].as_str().expect("icaclsOutput");
                    is_restricted_acl_listing(listing)
                }
                "posix" => {
                    let mode = sample["mode"].as_u64().expect("mode") as u32;
                    is_restricted_posix_mode(mode)
                }
                other => panic!("unknown ACL platform: {other}"),
            };
            assert_eq!(actual, expected, "ACL sample {id}");
        }
    }

    #[test]
    fn fresh_install_generates_a_random_password() {
        let dir = tempdir("fresh");
        let credentials = resolve_database_credentials(&dir).unwrap();
        assert_eq!(credentials.user, DATABASE_USER);
        assert!(!credentials.migration_required);
        assert_eq!(credentials.source, CredentialSource::Generated);
        let password = credentials.password.expect("password");
        assert!(!password.is_empty());

        let secrets = fs::read_to_string(dir.join(SECRETS_FILENAME)).expect("secrets file");
        assert!(secrets.contains(OBFUSCATION_PREFIX));
        assert!(!secrets.contains(&password));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_datastore_without_credentials_is_reported_unmigrated() {
        let dir = tempdir("legacy");
        seed_legacy_datastore(&dir);

        let credentials = resolve_database_credentials(&dir).expect("legacy state, not an error");
        assert_eq!(credentials.user, DATABASE_USER);
        assert_eq!(credentials.password, None);
        assert!(credentials.migration_required);
        assert_eq!(credentials.source, CredentialSource::LegacyUnmigrated);

        // The callers must not be able to turn the state into a usable
        // environment, and nothing may be written on the way through.
        assert!(build_credential_environment(&credentials).is_err());
        assert!(ensure_database_password(&dir).is_err());
        assert!(ensure_encryption_key(&dir).is_err());
        assert!(!dir.join(SECRETS_FILENAME).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stored_password_survives_a_restart() {
        let dir = tempdir("restart");
        let first = resolve_database_credentials(&dir).unwrap();
        let second = resolve_database_credentials(&dir).unwrap();
        assert_eq!(first.password, second.password);
        assert_eq!(second.source, CredentialSource::Stored);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_credentials_are_preserved_and_rejected() {
        let dir = tempdir("corrupt");
        let file = dir.join(SECRETS_FILENAME);
        write_restricted(&file, "{not json");
        assert!(resolve_database_credentials(&dir).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"{not json");
        let key = dir.join(KEY_FILENAME);
        write_restricted(&key, "obf:%%%");
        assert!(ensure_encryption_key(&dir).is_err());
        assert_eq!(fs::read(&key).unwrap(), b"obf:%%%");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn inaccessible_credential_path_fails_closed() {
        let dir = tempdir("unwritable");
        let path = dir.join("file");
        fs::write(&path, b"x").unwrap();
        assert!(resolve_database_credentials(&path).is_err());
        assert!(ensure_encryption_key(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn encryption_key_is_stable_and_obfuscated_at_rest() {
        let dir = tempdir("key");
        let first = ensure_encryption_key(&dir).unwrap();
        let second = ensure_encryption_key(&dir).unwrap();
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
            password: Some("s3cr3t".to_string()),
            migration_required: false,
            source: CredentialSource::Generated,
        })
        .expect("environment");
        assert_eq!(environment.surreal_user, DATABASE_USER);
        assert_eq!(environment.surreal_password, "s3cr3t");
        assert_eq!(environment.surreal_pass, "s3cr3t");
    }

    #[test]
    fn credential_environment_rejects_unusable_passwords() {
        for password in [String::new(), "bad\u{7}secret".to_string()] {
            let result = build_credential_environment(&DatabaseCredentials {
                user: DATABASE_USER.to_string(),
                password: Some(password),
                migration_required: false,
                source: CredentialSource::Stored,
            });
            assert!(result.is_err(), "a control character or empty value is unusable");
        }
    }

    #[test]
    fn every_shared_credential_state_matches_the_fixture() {
        let cases = cases();
        let states = cases["states"].as_array().expect("states");
        assert_eq!(states.len(), 10, "every shared credential state is checked");
        for state in states {
            let id = state["id"].as_str().expect("state id");
            let dir = tempdir(&format!("state-{}", id.replace('-', "_")));
            let secrets = dir.join(SECRETS_FILENAME);

            match state["datastore"].as_str().expect("datastore") {
                "present" => seed_legacy_datastore(&dir),
                "unreadable" => {
                    // A *file* where the datastore directory belongs cannot be
                    // descended into, which makes the inspection fail portably.
                    fs::write(dir.join(DATABASE_DIRNAME), b"not a directory").unwrap();
                }
                "absent" => {}
                other => panic!("unknown datastore state: {other}"),
            }

            match state["secrets"].as_str().expect("secrets") {
                "valid" => write_restricted(&secrets, &secrets_document(&encode_secret("shared-fixture-secret"))),
                "corrupt" => write_restricted(&secrets, "{not json"),
                "missing-field" => write_restricted(&secrets, "{\n  \"unrelated\": true\n}\n"),
                "undecodable" => write_restricted(&secrets, &secrets_document("obf:!!!!")),
                "empty" => write_restricted(&secrets, &secrets_document(&encode_secret(""))),
                "control-char" => {
                    write_restricted(&secrets, &secrets_document(&encode_secret("bad\u{7}secret")))
                }
                "absent" => {}
                other => panic!("unknown secrets state: {other}"),
            }

            if state["acl"].as_str().expect("acl") == "open" {
                widen_acl(&secrets);
            }

            let before = fs::read(&secrets).ok();
            let result = resolve_database_credentials(&dir);

            if state["outcome"].as_str().expect("outcome") == "rejected" {
                let message = result.expect_err(&format!("{id}: expected a rejection"));
                assert_eq!(
                    error_code(&message),
                    state["errorCode"].as_str().expect("errorCode"),
                    "{id}: {message}"
                );
            } else {
                let credentials = result.unwrap_or_else(|e| panic!("{id}: unexpected rejection: {e}"));
                assert_eq!(
                    source_name(credentials.source),
                    state["source"].as_str().expect("source"),
                    "{id}: source"
                );
                assert_eq!(
                    credentials.migration_required,
                    state["migrationRequired"].as_bool().expect("migrationRequired"),
                    "{id}: migrationRequired"
                );
                assert_eq!(
                    credentials.password.is_some(),
                    state["passwordAvailable"].as_bool().expect("passwordAvailable"),
                    "{id}: password availability"
                );
                if let Some(password) = &credentials.password {
                    assert!(!password.is_empty(), "{id}: password must not be empty");
                }
            }

            // No state ever rewrites the secrets file: an install must not lose
            // the only copy of a password the datastore still accepts.
            let writes = state["writesSecretsFile"].as_bool().expect("writesSecretsFile");
            if let Some(before) = before {
                if !writes {
                    assert_eq!(fs::read(&secrets).ok(), Some(before), "{id}: secrets file was rewritten");
                }
            } else {
                assert_eq!(secrets.exists(), writes, "{id}: secrets file appeared unexpectedly");
            }

            fs::remove_dir_all(&dir).ok();
        }
    }

    /// The shared source vocabulary, so a fixture mismatch is a compile error.
    fn source_name(source: CredentialSource) -> &'static str {
        match source {
            CredentialSource::LegacyUnmigrated => "legacy-unmigrated",
            CredentialSource::Stored => "stored",
            CredentialSource::Generated => "generated",
            CredentialSource::Migrated => "migrated",
        }
    }

    /// Renders a secrets file in the shared on-disk shape.
    fn secrets_document(value: &str) -> String {
        format!("{{\n  \"surrealPassword\": \"{}\"\n}}\n", value)
    }

    /// Creates the datastore directory a pre-existing install would have.
    fn seed_legacy_datastore(dir: &Path) {
        let db = dir.join(DATABASE_DIRNAME).join(DATABASE_FILENAME);
        fs::create_dir_all(&db).unwrap();
        fs::write(db.join("CURRENT"), b"x").unwrap();
    }

    /// Writes a secrets file with owner-only permissions.
    fn write_restricted(file: &Path, contents: &str) {
        if file.exists() {
            fs::remove_file(file).unwrap();
        }
        protected_write(file, contents).expect("restricted write");
    }

    /// Makes a file readable by every local account, so the restriction check
    /// has something real to reject.
    fn widen_acl(file: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("icacls")
                .arg(file)
                .arg("/grant")
                // `*S-1-1-0` is Everyone by well-known SID, in a form that does
                // not depend on the machine's locale.
                .arg("*S-1-1-0:(R)")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("icacls");
            assert!(status.success(), "could not widen the ACL");
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(file, fs::Permissions::from_mode(0o644)).unwrap();
        }
        assert!(
            !check_restricted_to_current_user(file),
            "the ACL was not actually widened"
        );
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
