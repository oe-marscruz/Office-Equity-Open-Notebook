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
// of its own data.
//
// An existing datastore with no secrets file is therefore reported as
// CredentialSourceLegacyUnmigrated, carrying no password at all, so the caller
// has to run the migration instead of quietly connecting as root. A damaged
// secrets file is reported and left untouched: it may still hold the only copy
// of the password the datastore accepts, and rewriting it would turn a
// recoverable problem into a lockout.
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
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

const (
	// KeyFilename holds the obfuscated provider-API-key encryption key.
	KeyFilename = "encryption-key.txt"
	// SecretsFilename holds the obfuscated SurrealDB root password.
	SecretsFilename = "secrets.json"
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
	// CredentialSourceLegacyUnmigrated means a datastore exists but no secrets
	// file does: the install predates per-install credentials and needs an
	// explicit migration. No password is returned for this state.
	CredentialSourceLegacyUnmigrated CredentialSource = "legacy-unmigrated"
	// CredentialSourceStored means the password was read back from disk.
	CredentialSourceStored CredentialSource = "stored"
	// CredentialSourceGenerated means the password was generated this run.
	CredentialSourceGenerated CredentialSource = "generated"
	// CredentialSourceMigrated means this process rotated a legacy install onto
	// a provisioned password. It is provenance, not state: the next launch
	// reads the same password back and reports CredentialSourceStored.
	CredentialSourceMigrated CredentialSource = "migrated"
)

// The failure modes every host reports for the same on-disk situation.
const (
	CredentialErrorInvalidSecretsFile  = "invalid-secrets-file"
	CredentialErrorInvalidSecretValue  = "invalid-secret-value"
	CredentialErrorPermissionsTooOpen  = "permissions-too-open"
	CredentialErrorDatastoreUnreadable = "datastore-unreadable"
	// CredentialErrorMigrationRejected means the datastore exists but does not
	// accept the legacy probe password, so nothing was rotated and nothing was
	// written. An operator has to supply the current password.
	CredentialErrorMigrationRejected = "migration-rejected"
)

// CredentialError is a credential failure with a machine-readable code, so
// callers can tell a damaged secret from a permissions problem without
// matching on prose.
type CredentialError struct {
	Code    string
	Message string
	Path    string
}

// Error renders the failure with the file it concerns.
func (e *CredentialError) Error() string {
	if e.Path == "" {
		return e.Message
	}
	return fmt.Sprintf("%s: %s", e.Message, e.Path)
}

// newCredentialError builds a CredentialError.
func newCredentialError(code, message, path string) error {
	return &CredentialError{Code: code, Message: message, Path: path}
}

// DatabaseCredentials are the SurrealDB credentials to start the database
// with.
//
// Password is nil until the install has been provisioned: a legacy install
// carries no password so no caller can accidentally connect with one.
type DatabaseCredentials struct {
	User     string
	Password *string
	// MigrationRequired is true when the datastore has not been provisioned
	// with a per-install password yet.
	MigrationRequired bool
	Source            CredentialSource
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
// and are returned unchanged, so existing installs keep working. A value that
// carries the prefix but cannot be decoded is an error rather than a silent
// fallback to the raw string: the raw string is not the password.
func DecodeSecretWith(stored string, key []byte) (string, error) {
	raw := strings.TrimSpace(stored)
	if !strings.HasPrefix(raw, ObfuscationPrefix) {
		if err := validateSecretValue(raw); err != nil {
			return "", err
		}
		return raw, nil
	}
	obfuscated, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, ObfuscationPrefix))
	if err != nil {
		return "", newCredentialError(CredentialErrorInvalidSecretValue, "Invalid encoded credential", "")
	}
	decoded := string(XorObfuscate(obfuscated, key))
	if err := validateSecretValue(decoded); err != nil {
		return "", err
	}
	return decoded, nil
}

// validateSecretValue rejects values that cannot be a password.
//
// An empty value would make the server accept connections with no password and
// a control character cannot survive a process environment or a CLI argument.
func validateSecretValue(value string) error {
	if value == "" {
		return newCredentialError(CredentialErrorInvalidSecretValue, "Invalid credential value", "")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return newCredentialError(CredentialErrorInvalidSecretValue, "Invalid credential value", "")
		}
	}
	return nil
}

// EncodeSecret obfuscates a secret with the machine-bound key.
func EncodeSecret(secret string) string {
	return EncodeSecretWith(secret, DeriveObfuscationKey())
}

// DecodeSecret decodes a stored secret value with the machine-bound key.
func DecodeSecret(stored string) (string, error) {
	return DecodeSecretWith(stored, DeriveObfuscationKey())
}

// RestrictToCurrentUser restricts a file to the current OS user.
//
// The restriction is verified afterwards rather than assumed: icacls can report
// success while a second ACE still exposes the secret, and a POSIX mode can be
// widened again after the fact.
func RestrictToCurrentUser(file string) error {
	if runtime.GOOS == "windows" {
		name := strings.TrimSpace(os.Getenv("USERNAME"))
		if name == "" {
			return newCredentialError(CredentialErrorPermissionsTooOpen, "Could not determine the current user", file)
		}
		cmd := exec.Command("icacls", file, "/inheritance:r", "/grant:r", name+":F")
		if err := cmd.Run(); err != nil {
			return newCredentialError(CredentialErrorPermissionsTooOpen, "Could not restrict credential file permissions", file)
		}
	} else if err := os.Chmod(file, 0600); err != nil {
		return newCredentialError(CredentialErrorPermissionsTooOpen, "Could not restrict credential file permissions", file)
	}
	return CheckRestrictedToCurrentUser(file)
}

// CheckRestrictedToCurrentUser reports whether file is provably readable only
// by the current OS user.
func CheckRestrictedToCurrentUser(file string) error {
	if runtime.GOOS == "windows" {
		output, err := exec.Command("icacls", file).Output()
		if err != nil {
			return newCredentialError(CredentialErrorPermissionsTooOpen, "Could not inspect credential file permissions", file)
		}
		if !IsRestrictedACLListing(string(output)) {
			return newCredentialError(CredentialErrorPermissionsTooOpen, "Credential file permissions are too open", file)
		}
		return nil
	}
	info, err := os.Stat(file)
	if err != nil {
		return newCredentialError(CredentialErrorPermissionsTooOpen, "Could not inspect credential file permissions", file)
	}
	if !IsRestrictedPosixMode(uint32(info.Mode().Perm())) {
		return newCredentialError(CredentialErrorPermissionsTooOpen, "Credential file permissions are too open", file)
	}
	return nil
}

// IsRestrictedACLListing classifies icacls output as owner-only or not.
//
// icacls interleaves diagnostics ("Successfully processed ...", an unresolved
// domain trust, a mandatory-integrity label) with the ACL itself, so the ACE
// lines are isolated before counting. Exactly one non-inherited full-control
// ACE is the only accepted shape.
func IsRestrictedACLListing(listing string) bool {
	aces := make([]string, 0, 4)
	for _, line := range strings.Split(listing, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" ||
			strings.HasPrefix(trimmed, "Successfully processed") ||
			strings.HasPrefix(trimmed, "Failed processing") ||
			strings.HasPrefix(trimmed, "The trust relationship") ||
			strings.HasPrefix(trimmed, "Mandatory Label") {
			continue
		}
		aces = append(aces, trimmed)
	}
	if len(aces) != 1 {
		return false
	}
	ace := aces[0]
	return !strings.Contains(ace, "(I)") && strings.HasSuffix(ace, "(F)")
}

// IsRestrictedPosixMode reports whether a POSIX mode grants nothing to group or
// other.
func IsRestrictedPosixMode(mode uint32) bool {
	return mode&0o077 == 0
}

// writeSecretFile writes contents to file and restricts it to the current OS
// user, failing rather than leaving an unrestricted secret behind.
func writeSecretFile(file, contents string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return newCredentialError(CredentialErrorInvalidSecretsFile, "Could not create credential directory", file)
	}
	handle, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return newCredentialError(CredentialErrorInvalidSecretsFile, "Could not create credential file", file)
	}
	if err := RestrictToCurrentUser(file); err != nil {
		handle.Close()
		return err
	}
	if _, err := handle.WriteString(contents); err != nil {
		handle.Close()
		return newCredentialError(CredentialErrorInvalidSecretsFile, "Could not write credential file", file)
	}
	if err := handle.Sync(); err != nil {
		handle.Close()
		return newCredentialError(CredentialErrorInvalidSecretsFile, "Could not persist credential file", file)
	}
	return handle.Close()
}

// readProtectedSecretFile reads a secret file, or returns ("", false, nil) when
// it does not exist.
//
// The permissions are checked rather than repaired: a file other accounts can
// read may already have exposed the secret, and silently tightening the ACL
// would hide that from the user.
func readProtectedSecretFile(file string) (string, bool, error) {
	contents, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, newCredentialError(CredentialErrorInvalidSecretsFile, "Could not read credential file", file)
	}
	if err := CheckRestrictedToCurrentUser(file); err != nil {
		return "", false, err
	}
	return string(contents), true, nil
}

// HasExistingDatastore reports whether dataDir already holds a SurrealDB
// datastore from an earlier run.
//
// RocksDB stores its datastore in a directory, which reports a size of 0 on
// Windows, so both shapes have to be checked. Inspection failures are errors
// rather than "false": reporting a fresh install for an unreadable datastore
// would overwrite the credentials of an install that still works.
func HasExistingDatastore(dataDir string) (bool, error) {
	dir := filepath.Join(dataDir, DatabaseDirname)
	file := filepath.Join(dir, DatabaseFilename)
	// A datastore path occupied by something other than a directory cannot be
	// inspected. Windows reports this shape as "not found" all the way down,
	// which would otherwise be indistinguishable from a fresh install.
	if dirInfo, dirErr := os.Stat(dir); dirErr == nil && !dirInfo.IsDir() {
		return false, newCredentialError(CredentialErrorDatastoreUnreadable, "Could not inspect datastore", dir)
	}
	info, err := os.Stat(file)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return false, newCredentialError(CredentialErrorDatastoreUnreadable, "Could not inspect datastore", file)
		}
		// The file is absent. The directory itself still has to be
		// inspectable: a directory that exists but cannot be listed hides a
		// legacy datastore just as effectively as an unreadable file does.
		if _, dirErr := os.ReadDir(dir); dirErr != nil {
			if errors.Is(dirErr, os.ErrNotExist) {
				return false, nil
			}
			return false, newCredentialError(CredentialErrorDatastoreUnreadable, "Could not inspect datastore", dir)
		}
		return false, nil
	}
	if info.IsDir() {
		entries, err := os.ReadDir(file)
		if err != nil {
			return false, newCredentialError(CredentialErrorDatastoreUnreadable, "Could not inspect datastore", file)
		}
		return len(entries) > 0, nil
	}
	return info.Size() > 0, nil
}

// EnsureDatabasePassword returns the persisted database password for dataDir,
// generating one on first use.
//
// A secrets file that cannot be parsed or decoded is reported and left
// untouched: it may still hold the only copy of the password the datastore
// accepts, and rewriting it would turn a recoverable problem into a lockout.
// The legacy-unmigrated case is signalled by ResolveDatabaseCredentials, not
// here.
func EnsureDatabasePassword(dataDir string) (string, error) {
	secretsFile := filepath.Join(dataDir, SecretsFilename)
	contents, exists, err := readProtectedSecretFile(secretsFile)
	if err != nil {
		return "", err
	}
	if exists {
		var parsed struct {
			SurrealPassword string `json:"surrealPassword"`
		}
		if err := json.Unmarshal([]byte(contents), &parsed); err != nil || parsed.SurrealPassword == "" {
			return "", newCredentialError(CredentialErrorInvalidSecretsFile, "Invalid database credential file", secretsFile)
		}
		return DecodeSecret(parsed.SurrealPassword)
	}
	found, err := HasExistingDatastore(dataDir)
	if err != nil {
		return "", err
	}
	if found {
		return "", newCredentialError(CredentialErrorInvalidSecretsFile, "Existing datastore has no credential file; recovery is required", secretsFile)
	}
	password, err := randomPassword()
	if err != nil {
		return "", err
	}
	encoded, err := json.MarshalIndent(map[string]string{
		"surrealPassword": EncodeSecret(password),
	}, "", "  ")
	if err != nil {
		return "", newCredentialError(CredentialErrorInvalidSecretsFile, "Could not serialize database credential", secretsFile)
	}
	if err := writeSecretFile(secretsFile, string(encoded)+"\n"); err != nil {
		return "", err
	}
	return password, nil
}

// randomPassword generates a random base64url password.
//
// A random-source failure stops startup: a deterministic placeholder would be
// a publicly known password on a loopback service.
func randomPassword() (string, error) {
	buffer := make([]byte, DatabasePasswordBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", newCredentialError(CredentialErrorInvalidSecretValue, "Secure random generator failed", "")
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// ResolveDatabaseCredentials resolves the SurrealDB credentials to start the
// database with.
//
// Every host reports one of three states for the same on-disk situation:
// "generated" for a fresh install, "stored" for a readable secrets file, and
// "legacy-unmigrated" for a datastore without a secrets file. The last one
// carries no password, because SurrealDB applies the initial root credentials
// only when no root user exists yet: a password invented here would have no
// effect and the backend would be locked out of its own data.
func ResolveDatabaseCredentials(dataDir string) (DatabaseCredentials, error) {
	secretsFile := filepath.Join(dataDir, SecretsFilename)
	_, statErr := os.Stat(secretsFile)
	hadSecrets := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return DatabaseCredentials{}, newCredentialError(CredentialErrorInvalidSecretsFile, "Could not inspect database credential file", secretsFile)
	}

	if !hadSecrets {
		found, err := HasExistingDatastore(dataDir)
		if err != nil {
			return DatabaseCredentials{}, err
		}
		if found {
			return DatabaseCredentials{
				User:              DatabaseUser,
				Password:          nil,
				MigrationRequired: true,
				Source:            CredentialSourceLegacyUnmigrated,
			}, nil
		}
	}

	password, err := EnsureDatabasePassword(dataDir)
	if err != nil {
		return DatabaseCredentials{}, err
	}
	source := CredentialSourceGenerated
	if hadSecrets {
		source = CredentialSourceStored
	}
	return DatabaseCredentials{
		User:              DatabaseUser,
		Password:          &password,
		MigrationRequired: false,
		Source:            source,
	}, nil
}

// EnsureEncryptionKey returns the persisted encryption key for dataDir,
// generating a random 32-byte key on first use.
//
// The key is stored obfuscated so it never appears in plaintext on disk. Legacy
// plaintext key files are still readable, but any stored key must have the
// documented shape: a key of the wrong length or alphabet cannot encrypt
// anything and must be reported rather than replaced.
func EnsureEncryptionKey(dataDir string) (string, error) {
	keyFile := filepath.Join(dataDir, KeyFilename)
	contents, exists, err := readProtectedSecretFile(keyFile)
	if err != nil {
		return "", err
	}
	if exists {
		key, err := DecodeSecret(contents)
		if err != nil {
			return "", newCredentialError(CredentialErrorInvalidSecretValue, "Invalid encryption key", keyFile)
		}
		if len(key) != EncryptionKeyBytes*2 || !isLowerHex(key) {
			return "", newCredentialError(CredentialErrorInvalidSecretValue, "Invalid encryption key", keyFile)
		}
		return key, nil
	}
	found, err := HasExistingDatastore(dataDir)
	if err != nil {
		return "", err
	}
	if found {
		return "", newCredentialError(CredentialErrorInvalidSecretsFile, "Existing datastore has no encryption key; recovery is required", keyFile)
	}
	buffer := make([]byte, EncryptionKeyBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", newCredentialError(CredentialErrorInvalidSecretValue, "Secure random generator failed", "")
	}
	key := hex.EncodeToString(buffer)
	if err := writeSecretFile(keyFile, EncodeSecret(key)); err != nil {
		return "", err
	}
	return key, nil
}

// isLowerHex reports whether value is 64 lowercase hex digits or similar: the
// on-disk shape of the encryption key.
func isLowerHex(value string) bool {
	for _, r := range value {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return false
		}
	}
	return true
}

// BuildCredentialEnvironment builds the environment variables that carry the
// database credentials to the SurrealDB server and the Python backend.
//
// SurrealDB's own CLI reads SURREAL_USER and SURREAL_PASS. The upstream backend
// reads SURREAL_USER and SURREAL_PASSWORD, falling back to SURREAL_PASS. Both
// are therefore set to the same value.
//
// The credentials are passed through the process environment rather than the
// command line so they never appear in the process listing.
//
// A legacy-unmigrated install has no password yet, so this is fallible rather
// than defaulting to a usable value: inheriting root here is what let every
// host connect to a pre-existing datastore without anyone noticing.
func BuildCredentialEnvironment(credentials DatabaseCredentials) (CredentialEnvironment, error) {
	if credentials.Password == nil {
		return CredentialEnvironment{}, newCredentialError(CredentialErrorInvalidSecretValue, "Database credentials have not been provisioned; recovery is required", "")
	}
	if err := validateSecretValue(*credentials.Password); err != nil {
		return CredentialEnvironment{}, err
	}
	return CredentialEnvironment{
		SurrealUser:     credentials.User,
		SurrealPassword: *credentials.Password,
		SurrealPass:     *credentials.Password,
	}, nil
}
