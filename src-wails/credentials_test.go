package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// credentialCases mirrors tests/contracts/credentials-cases.json, the shared
// cross-host fixture. Every host must reproduce these values byte-for-byte.
type credentialCases struct {
	Description            string `json:"description"`
	ObfuscationPrefix      string `json:"obfuscationPrefix"`
	ObfuscationSalt        string `json:"obfuscationSalt"`
	EncodedSecret          string `json:"encodedSecret"`
	EncodedSecretPlaintext string `json:"encodedSecretPlaintext"`
	EncodedSecretUsername  string `json:"encodedSecretKeyUsername"`
	EncodedSecretHostname  string `json:"encodedSecretKeyHostname"`
	LegacyPlaintextSecret  string `json:"legacyPlaintextSecret"`
	DomainQualifiedUser    string `json:"domainQualifiedUsername"`
	StrippedUsername       string `json:"strippedUsername"`
	DerivationVectors      []struct {
		Username string `json:"username"`
		Hostname string `json:"hostname"`
		KeyHex   string `json:"keyHex"`
	} `json:"derivationVectors"`
}

func loadCredentialCases(t *testing.T) credentialCases {
	t.Helper()
	path := filepath.Join("..", "tests", "contracts", "credentials-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("Fixture file not found: %s", path)
		return credentialCases{}
	}
	var cases credentialCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("Failed parsing credential fixtures: %v", err)
	}
	return cases
}

func TestCredentialConstantsMatchFixture(t *testing.T) {
	cases := loadCredentialCases(t)
	if ObfuscationPrefix != cases.ObfuscationPrefix {
		t.Errorf("ObfuscationPrefix = %q, want %q", ObfuscationPrefix, cases.ObfuscationPrefix)
	}
	if ObfuscationSalt != cases.ObfuscationSalt {
		t.Errorf("ObfuscationSalt = %q, want %q", ObfuscationSalt, cases.ObfuscationSalt)
	}
}

func TestDerivationMatchesSharedVectors(t *testing.T) {
	cases := loadCredentialCases(t)
	for _, vector := range cases.DerivationVectors {
		key := DeriveObfuscationKeyFrom(vector.Username, vector.Hostname)
		if got := hexEncode(key); got != vector.KeyHex {
			t.Errorf("derivation for %q@%q = %q, want %q", vector.Username, vector.Hostname, got, vector.KeyHex)
		}
	}
}

func TestObfuscationMatchesSharedVector(t *testing.T) {
	cases := loadCredentialCases(t)
	key := DeriveObfuscationKeyFrom(cases.EncodedSecretUsername, cases.EncodedSecretHostname)
	if got := EncodeSecretWith(cases.EncodedSecretPlaintext, key); got != cases.EncodedSecret {
		t.Errorf("encoded secret = %q, want %q", got, cases.EncodedSecret)
	}
}

func TestObfuscationRoundTrips(t *testing.T) {
	cases := loadCredentialCases(t)
	key := DeriveObfuscationKeyFrom(cases.EncodedSecretUsername, cases.EncodedSecretHostname)
	encoded := EncodeSecretWith(cases.EncodedSecretPlaintext, key)
	if got := DecodeSecretWith(encoded, key); got != cases.EncodedSecretPlaintext {
		t.Errorf("decoded secret = %q, want %q", got, cases.EncodedSecretPlaintext)
	}
}

func TestLegacyPlaintextIsReturnedUnchanged(t *testing.T) {
	cases := loadCredentialCases(t)
	key := DeriveObfuscationKeyFrom(cases.EncodedSecretUsername, cases.EncodedSecretHostname)
	if got := DecodeSecretWith(cases.LegacyPlaintextSecret, key); got != cases.LegacyPlaintextSecret {
		t.Errorf("legacy secret = %q, want %q", got, cases.LegacyPlaintextSecret)
	}
}

func TestStripsDomainQualifier(t *testing.T) {
	cases := loadCredentialCases(t)
	if got := StripUserDomain(cases.DomainQualifiedUser); got != cases.StrippedUsername {
		t.Errorf("StripUserDomain(%q) = %q, want %q", cases.DomainQualifiedUser, got, cases.StrippedUsername)
	}
	if got := StripUserDomain("plain"); got != "plain" {
		t.Errorf("StripUserDomain(plain) = %q, want plain", got)
	}
	if got := StripUserDomain("  "); got != "" {
		t.Errorf("StripUserDomain(blank) = %q, want empty", got)
	}
}

func TestFreshInstallGeneratesRandomPassword(t *testing.T) {
	dir := t.TempDir()
	credentials := ResolveDatabaseCredentials(dir)
	if credentials.User != DatabaseUser {
		t.Errorf("user = %q, want %q", credentials.User, DatabaseUser)
	}
	if credentials.Legacy {
		t.Error("fresh install must not use the legacy credential")
	}
	if credentials.Source != CredentialSourceGenerated {
		t.Errorf("source = %q, want %q", credentials.Source, CredentialSourceGenerated)
	}
	if credentials.Password == "" {
		t.Error("password must not be empty")
	}

	contents, err := os.ReadFile(filepath.Join(dir, SecretsFilename))
	if err != nil {
		t.Fatalf("reading secrets file: %v", err)
	}
	if !contains(string(contents), ObfuscationPrefix) {
		t.Error("secrets file must be obfuscated at rest")
	}
	if contains(string(contents), credentials.Password) {
		t.Error("secrets file must not contain the plaintext password")
	}
}

func TestExistingDatastoreKeepsLegacyPassword(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, DatabaseDirname, DatabaseFilename)
	if err := os.MkdirAll(db, 0755); err != nil {
		t.Fatalf("creating datastore dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(db, "CURRENT"), []byte("x"), 0644); err != nil {
		t.Fatalf("writing datastore file: %v", err)
	}

	credentials := ResolveDatabaseCredentials(dir)
	if credentials.Password != LegacyDatabasePassword {
		t.Errorf("password = %q, want %q", credentials.Password, LegacyDatabasePassword)
	}
	if !credentials.Legacy {
		t.Error("existing datastore must use the legacy credential")
	}
	if credentials.Source != CredentialSourceLegacy {
		t.Errorf("source = %q, want %q", credentials.Source, CredentialSourceLegacy)
	}
	if _, err := os.Stat(filepath.Join(dir, SecretsFilename)); err == nil {
		t.Error("legacy install must not create a secrets file")
	}
}

func TestStoredPasswordSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	first := ResolveDatabaseCredentials(dir)
	second := ResolveDatabaseCredentials(dir)
	if first.Password != second.Password {
		t.Error("stored password must be stable across restarts")
	}
	if second.Source != CredentialSourceStored {
		t.Errorf("source = %q, want %q", second.Source, CredentialSourceStored)
	}
}

func TestCorruptSecretsFileIsRegenerated(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, SecretsFilename), []byte("{not json"), 0600); err != nil {
		t.Fatalf("writing corrupt file: %v", err)
	}
	credentials := ResolveDatabaseCredentials(dir)
	if credentials.Password == "" {
		t.Error("password must not be empty")
	}
	if credentials.Legacy {
		t.Error("corrupt secrets file must not fall back to the legacy credential")
	}
}

func TestEncryptionKeyIsStableAndObfuscatedAtRest(t *testing.T) {
	dir := t.TempDir()
	first := EnsureEncryptionKey(dir)
	second := EnsureEncryptionKey(dir)
	if first != second {
		t.Error("encryption key must be stable")
	}
	if len(first) != EncryptionKeyBytes*2 {
		t.Errorf("key length = %d, want %d", len(first), EncryptionKeyBytes*2)
	}

	contents, err := os.ReadFile(filepath.Join(dir, KeyFilename))
	if err != nil {
		t.Fatalf("reading key file: %v", err)
	}
	if !contains(string(contents), ObfuscationPrefix) {
		t.Error("key file must be obfuscated at rest")
	}
	if contains(string(contents), first) {
		t.Error("key file must not contain the plaintext key")
	}
}

func TestCredentialEnvironmentCarriesThePassword(t *testing.T) {
	environment := BuildCredentialEnvironment(DatabaseCredentials{
		User:     DatabaseUser,
		Password: "s3cr3t",
	})
	if environment.SurrealUser != DatabaseUser {
		t.Errorf("SURREAL_USER = %q, want %q", environment.SurrealUser, DatabaseUser)
	}
	if environment.SurrealPassword != "s3cr3t" || environment.SurrealPass != "s3cr3t" {
		t.Error("both SURREAL_PASSWORD and SURREAL_PASS must carry the password")
	}
}

// hexEncode renders bytes as lowercase hex.
func hexEncode(data []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(data)*2)
	for i, b := range data {
		out[i*2] = digits[b>>4]
		out[i*2+1] = digits[b&0x0f]
	}
	return string(out)
}

// contains reports whether haystack contains needle.
func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

// indexOf returns the index of needle in haystack, or -1.
func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
