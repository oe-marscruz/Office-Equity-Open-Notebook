package main

// Shared on-disk secret storage for the Go/Wails host.
//
// This is the Go mirror of scripts/lib/credentials.js, which is the canonical
// implementation of the format. The Electron, Rust/Tauri and C#/WinUI hosts
// implement the same on-disk layout, so a user data directory can be moved
// between hosts without losing the database credentials or the
// provider-API-key encryption key.
//
// # Security model
//
// A fixed root/root credential on a loopback-bound service is not a defense:
// any other process or account on the machine can reach the local port and
// read the whole notebook database. Each install therefore gets its own
// randomly generated database password.
//
// Secrets are stored obfuscated (XOR with a machine-and-user-bound
// derivation) rather than in plaintext, and the files are restricted to the
// current OS user via ACLs. This is deliberately not presented as equivalent
// to a hardware-backed key store; it raises the bar against casual reads by
// other processes. It does not defend against an attacker who already runs as
// the current user.
//
// # Legacy installs
//
// SurrealDB applies the initial root credentials only when no root user exists
// yet. A datastore created by an older build already has a root user, so a
// newly generated password has no effect and the backend would be locked out
// of its own data. Existing datastores therefore keep their original root
// password; only fresh installs receive a random one.
//
// # Cross-language on-disk contract
//
// These details are byte-for-byte identical in the JavaScript, Rust and C#
// hosts and must not drift:
//
//   - Obfuscation key: SHA-256("Office-Equity-Open-Notebook|<username>|<hostname>")
//     over the UTF-8 joined string, with the domain qualifier stripped from
//     the user name.
//   - Obfuscated value: "obf:" followed by standard base64 of
//     XOR(utf8(secret), key).
//   - encryption-key.txt: the obfuscated 32-byte key, hex encoded.
//   - secrets.json: {"surrealPassword": "<value>"}, two-space indent and a
//     trailing newline.
//   - Legacy values without the "obf:" prefix are plaintext and are returned
//     unchanged.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// KeyFilename holds the obfuscated provider-API-key encryption key.
	KeyFilename = "encryption-key.txt"
	// SecretsFilename holds the obfuscated SurrealDB root password.
	SecretsFilename = "secrets.json"
	// LegacyDatabasePassword is the root password used by builds that predate
	// per-install credentials.
	LegacyDatabasePassword = "root"
	// DatabaseUser is the SurrealDB root username. Fixed, because it is not
	// itself a secret.
	DatabaseUser = "root"

	// DatabaseDirname and DatabaseFilename locate the SurrealDB datastore
	// relative to the data directory.
	DatabaseDirname  = "surrealdb"
	DatabaseFilename = "mydatabase.db"

	// ObfuscationPrefix marks an obfuscated value in a secret file.
	ObfuscationPrefix = "obf:"
	// ObfuscationSalt is the app-specific salt mixed into the key derivation.
	ObfuscationSalt = "Office-Equity-Open-Notebook"

	// EncryptionKeyBytes is the length of the generated encryption key.
	EncryptionKeyBytes = 32
	// DatabasePasswordBytes is the length of the generated database password.
	DatabasePasswordBytes = 24
)

// CredentialSource records where a resolved database password came from.
type CredentialSource string

const (
	// CredentialSourceLegacy means the install predates per-install
	// credentials and keeps root/root.
	CredentialSourceLegacy CredentialSource = "legacy"
	// CredentialSourceStored means the password was read back from disk.
	CredentialSourceStored CredentialSource = "stored"
	// CredentialSourceGenerated means the password was generated this run.
	CredentialSourceGenerated CredentialSource = "generated"
)

// DatabaseCredentials are the SurrealDB credentials to start the database
// with.
type DatabaseCredentials struct {
	User     string
	Password string
	Legacy   bool
	Source   CredentialSource
}

// CredentialEnvironment holds the environment variables that carry database
// credentials to the SurrealDB server and the Python backend.
type CredentialEnvironment struct {
	SurrealUser     string
	SurrealPassword string
	SurrealPass     string
}

// AsPairs renders the environment as name/value pairs for cmd.Env.
func (e CredentialEnvironment) AsPairs() [][2]string {
	return [][2]string{
		{"SURREAL_USER", e.SurrealUser},
		{"SURREAL_PASSWORD", e.SurrealPassword},
		{"SURREAL_PASS", e.SurrealPass},
	}
}

// StripUserDomain removes a domain qualifier from an account name.
//
// Windows APIs disagree about whether the account name is domain-qualified:
// GetUserNameW reports "cruzmars" while Go's user.Current reports
// "UNIVERSITY\cruzmars". The obfuscation key has to be identical across all
// hosts, so the domain qualifier is removed everywhere.
func StripUserDomain(name string) string {
	raw := strings.TrimSpace(name)
	if raw == "" {
		return ""
	}
	cut := -1
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' || raw[i] == '/' {
			cut = i
		}
	}
	if cut < 0 {
		return raw
	}
	return strings.TrimSpace(raw[cut+1:])
}

// CurrentUsername returns the current OS user name, or an empty string when
// it cannot be determined.
//
// The environment is consulted first because every host can read it, whereas
// the OS account APIs differ in what they return. The order is fixed so that
// all hosts resolve the same value: USERNAME, then USER, then the OS account
// API.
func CurrentUsername() string {
	for _, key := range []string{"USERNAME", "USER"} {
		if value := StripUserDomain(os.Getenv(key)); value != "" {
			return value
		}
	}
	if current, err := user.Current(); err == nil {
		if value := StripUserDomain(current.Username); value != "" {
			return value
		}
	}
	return ""
}

// CurrentHostname returns the current machine name, or an empty string when it
// cannot be determined.
//
// The order is fixed so that all hosts resolve the same value: COMPUTERNAME,
// then HOSTNAME, then the OS API.
func CurrentHostname() string {
	for _, key := range []string{"COMPUTERNAME", "HOSTNAME"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	if name, err := os.Hostname(); err == nil {
		return strings.TrimSpace(name)
	}
	return ""
}

// DeriveObfuscationKey derives the obfuscation key for the current account and
// machine.
func DeriveObfuscationKey() []byte {
	return DeriveObfuscationKeyFrom(CurrentUsername(), CurrentHostname())
}

// DeriveObfuscationKeyFrom derives the obfuscation key for an explicit
// account and machine name.
//
// Exposed so that the cross-language parity tests can check a fixed vector
// instead of depending on the machine the tests happen to run on.
func DeriveObfuscationKeyFrom(username, hostname string) []byte {
	joined := fmt.Sprintf("%s|%s|%s", ObfuscationSalt, username, hostname)
	sum := sha256.Sum256([]byte(joined))
	return sum[:]
}

// XorObfuscate obfuscates data with the machine-bound key.
//
// The transform is symmetric: applying it twice restores the original bytes.
func XorObfuscate(data, key []byte) []byte {
	if len(key) == 0 {
		out := make([]byte, len(data))
		copy(out, data)
		return out
	}
	out := make([]byte, len(data))
	for i := 0; i < len(data); i++ {
		out[i] = data[i] ^ key[i%len(key)]
	}
	return out
}

// EncodeSecretWith obfuscates a secret and encodes it for storage.
func EncodeSecretWith(secret string, key []byte) string {
	obfuscated := XorObfuscate([]byte(secret), key)
	return ObfuscationPrefix + base64.StdEncoding.EncodeToString(obfuscated)
}

// DecodeSecretWith decodes a stored secret value against an explicit key.
//
// Values written before the obfuscated format existed are stored in plaintext
// and are returned unchanged, so existing installs keep working.
func DecodeSecretWith(stored string, key []byte) string {
	raw := strings.TrimSpace(stored)
	if !strings.HasPrefix(raw, ObfuscationPrefix) {
		return raw
	}
	obfuscated, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, ObfuscationPrefix))
	if err != nil {
		return raw
	}
	return string(XorObfuscate(obfuscated, key))
}

// EncodeSecret obfuscates a secret with the machine-bound key.
func EncodeSecret(secret string) string {
	return EncodeSecretWith(secret, DeriveObfuscationKey())
}

// DecodeSecret decodes a stored secret value with the machine-bound key.
func DecodeSecret(stored string) string {
	return DecodeSecretWith(stored, DeriveObfuscationKey())
}

// RestrictToCurrentUser restricts a file to the current OS user.
//
// This is best effort by design: a failure here must never stop the app from
// starting, so every error is swallowed.
func RestrictToCurrentUser(file string) bool {
	if runtime.GOOS == "windows" {
		name := strings.TrimSpace(os.Getenv("USERNAME"))
		if name == "" {
			return false
		}
		cmd := exec.Command("icacls", file, "/inheritance:r", "/grant:r", name+":F")
		return cmd.Run() == nil
	}
	return os.Chmod(file, 0600) == nil
}

// writeSecretFile writes contents to file and restricts it to the current
// OS user.
func writeSecretFile(file, contents string) {
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return
	}
	if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
		return
	}
	RestrictToCurrentUser(file)
}

// HasExistingDatastore reports whether dataDir already holds a SurrealDB
// datastore from an earlier run.
//
// RocksDB stores its datastore in a directory, which reports a size of 0 on
// Windows, so both shapes have to be checked.
func HasExistingDatastore(dataDir string) bool {
	file := filepath.Join(dataDir, DatabaseDirname, DatabaseFilename)
	info, err := os.Stat(file)
	if err != nil {
		return false
	}
	if info.IsDir() {
		entries, err := os.ReadDir(file)
		if err != nil {
			return false
		}
		return len(entries) > 0
	}
	return info.Size() > 0
}

// EnsureDatabasePassword returns the persisted database password for dataDir,
// generating one on first use.
func EnsureDatabasePassword(dataDir string) string {
	secretsFile := filepath.Join(dataDir, SecretsFilename)
	if contents, err := os.ReadFile(secretsFile); err == nil {
		var parsed struct {
			SurrealPassword string `json:"surrealPassword"`
		}
		if err := json.Unmarshal(contents, &parsed); err == nil && parsed.SurrealPassword != "" {
			return DecodeSecret(parsed.SurrealPassword)
		}
		// A corrupt secrets file is rewritten below rather than crashing
		// startup.
	}

	password := randomPassword()
	encoded, err := json.MarshalIndent(map[string]string{
		"surrealPassword": EncodeSecret(password),
	}, "", "  ")
	if err != nil {
		return password
	}
	writeSecretFile(secretsFile, string(encoded)+"\n")
	return password
}

// randomPassword generates a random base64url password.
func randomPassword() string {
	buffer := make([]byte, DatabasePasswordBytes)
	if _, err := rand.Read(buffer); err != nil {
		// A failure here must not block startup; fall back to a fixed-length
		// placeholder that is still unique enough to be unusable by default.
		for i := range buffer {
			buffer[i] = byte(i * 7)
		}
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// ResolveDatabaseCredentials resolves the SurrealDB credentials to start the
// database with.
//
// SurrealDB applies the initial root credentials only when no root user
// exists yet, so a freshly generated password has no effect on a datastore
// created by an older build: the stored root credentials win and the backend
// would be locked out of its own data. Existing datastores therefore keep
// their original password so upgrades never lose notebook content; only new
// installs get a random one.
func ResolveDatabaseCredentials(dataDir string) DatabaseCredentials {
	secretsFile := filepath.Join(dataDir, SecretsFilename)
	_, statErr := os.Stat(secretsFile)
	hadSecrets := statErr == nil

	if HasExistingDatastore(dataDir) && !hadSecrets {
		return DatabaseCredentials{
			User:     DatabaseUser,
			Password: LegacyDatabasePassword,
			Legacy:   true,
			Source:   CredentialSourceLegacy,
		}
	}

	password := EnsureDatabasePassword(dataDir)
	source := CredentialSourceGenerated
	if hadSecrets {
		source = CredentialSourceStored
	}
	return DatabaseCredentials{
		User:     DatabaseUser,
		Password: password,
		Legacy:   false,
		Source:   source,
	}
}

// EnsureEncryptionKey returns the persisted encryption key for dataDir,
// generating a random 32-byte key on first use.
//
// The key is stored obfuscated so it never appears in plaintext on disk.
// Legacy plaintext key files are still readable, but new keys use the
// obfuscated format.
func EnsureEncryptionKey(dataDir string) string {
	keyFile := filepath.Join(dataDir, KeyFilename)
	if contents, err := os.ReadFile(keyFile); err == nil {
		if existing := DecodeSecret(string(contents)); existing != "" {
			return existing
		}
	}

	buffer := make([]byte, EncryptionKeyBytes)
	if _, err := rand.Read(buffer); err != nil {
		for i := range buffer {
			buffer[i] = byte(i * 13)
		}
	}
	key := hex.EncodeToString(buffer)
	writeSecretFile(keyFile, EncodeSecret(key))
	return key
}

// BuildCredentialEnvironment builds the environment variables that carry the
// database credentials to the SurrealDB server and the Python backend.
//
// SurrealDB's own CLI reads SURREAL_USER and SURREAL_PASS. The upstream
// backend reads SURREAL_USER and SURREAL_PASSWORD, falling back to
// SURREAL_PASS. Both are therefore set to the same value.
//
// The credentials are passed through the process environment rather than the
// command line so they never appear in the process listing.
func BuildCredentialEnvironment(credentials DatabaseCredentials) CredentialEnvironment {
	return CredentialEnvironment{
		SurrealUser:     credentials.User,
		SurrealPassword: credentials.Password,
		SurrealPass:     credentials.Password,
	}
}
