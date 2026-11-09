package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	Sources     []string          `json:"sources"`
	ErrorCodes  map[string]string `json:"errorCodes"`
	AclSamples  []aclSample       `json:"aclSamples"`
	States      []credentialState `json:"states"`
}

// aclSample is one icacls listing or POSIX mode from the fixture.
type aclSample struct {
	ID          string  `json:"id"`
	Platform    string  `json:"platform"`
	Description string  `json:"description"`
	Icacls      string  `json:"icaclsOutput"`
	Mode        *uint32 `json:"mode"`
	Restricted  bool    `json:"restricted"`
}

// credentialState is one on-disk situation every host has to report the same
// way.
type credentialState struct {
	ID               string  `json:"id"`
	Description      string  `json:"description"`
	Datastore        string  `json:"datastore"`
	Secrets          string  `json:"secrets"`
	ACL              string  `json:"acl"`
	Outcome          string  `json:"outcome"`
	Source           *string `json:"source"`
	Legacy           bool    `json:"legacy"`
	PasswordAvailable bool   `json:"passwordAvailable"`
	WritesSecretsFile bool   `json:"writesSecretsFile"`
	ErrorCode        *string `json:"errorCode"`
}

func loadCredentialCases(t *testing.T) credentialCases {
	t.Helper()
	path := filepath.Join("..", "tests", "contracts", "credentials-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Reading credential fixture %s: %v", path, err)
	}
	var cases credentialCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("Parsing credential fixtures: %v", err)
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
	if DatabaseUser != "root" {
		t.Errorf("DatabaseUser = %q, want root", DatabaseUser)
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
	got, err := DecodeSecretWith(encoded, key)
	if err != nil {
		t.Fatalf("decoding the round-trip secret: %v", err)
	}
	if got != cases.EncodedSecretPlaintext {
		t.Errorf("decoded secret = %q, want %q", got, cases.EncodedSecretPlaintext)
	}
}

func TestLegacyPlaintextIsReturnedUnchanged(t *testing.T) {
	cases := loadCredentialCases(t)
	key := DeriveObfuscationKeyFrom(cases.EncodedSecretUsername, cases.EncodedSecretHostname)
	got, err := DecodeSecretWith(cases.LegacyPlaintextSecret, key)
	if err != nil {
		t.Fatalf("decoding the legacy plaintext secret: %v", err)
	}
	if got != cases.LegacyPlaintextSecret {
		t.Errorf("legacy secret = %q, want %q", got, cases.LegacyPlaintextSecret)
	}
}

func TestUnusableSecretValuesAreRejected(t *testing.T) {
	key := DeriveObfuscationKeyFrom("user", "host")
	for _, stored := range []string{
		"",
		ObfuscationPrefix,
		ObfuscationPrefix + "!!!!",
		EncodeSecretWith("has\u0007control", key),
	} {
		if _, err := DecodeSecretWith(stored, key); err == nil {
			t.Errorf("stored value %q decoded to a usable secret", stored)
		}
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
	credentials, err := ResolveDatabaseCredentials(dir)
	if err != nil {
		t.Fatalf("resolving a fresh install: %v", err)
	}
	if credentials.User != DatabaseUser {
		t.Errorf("user = %q, want %q", credentials.User, DatabaseUser)
	}
	if credentials.Legacy {
		t.Error("fresh install must not use the legacy credential")
	}
	if credentials.Source != CredentialSourceGenerated {
		t.Errorf("source = %q, want %q", credentials.Source, CredentialSourceGenerated)
	}
	if credentials.Password == nil || *credentials.Password == "" {
		t.Fatal("password must not be empty")
	}

	contents, err := os.ReadFile(filepath.Join(dir, SecretsFilename))
	if err != nil {
		t.Fatalf("reading secrets file: %v", err)
	}
	if !contains(string(contents), ObfuscationPrefix) {
		t.Error("secrets file must be obfuscated at rest")
	}
	if contains(string(contents), *credentials.Password) {
		t.Error("secrets file must not contain the plaintext password")
	}
}

func TestExistingDatastoreIsReportedAsUnmigrated(t *testing.T) {
	dir := t.TempDir()
	seedsLegacyDatastore(t, dir)

	credentials, err := ResolveDatabaseCredentials(dir)
	if err != nil {
		t.Fatalf("resolving an unmigrated install: %v", err)
	}
	if credentials.Password != nil {
		t.Errorf("password = %q, want no password", *credentials.Password)
	}
	if !credentials.Legacy {
		t.Error("a datastore without a secrets file is an unmigrated install")
	}
	if credentials.Source != CredentialSourceLegacyUnmigrated {
		t.Errorf("source = %q, want %q", credentials.Source, CredentialSourceLegacyUnmigrated)
	}
	if _, err := os.Stat(filepath.Join(dir, SecretsFilename)); err == nil {
		t.Error("an unmigrated install must not create a secrets file")
	}
}

func TestStoredPasswordSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	first, err := ResolveDatabaseCredentials(dir)
	if err != nil {
		t.Fatalf("first resolution: %v", err)
	}
	second, err := ResolveDatabaseCredentials(dir)
	if err != nil {
		t.Fatalf("second resolution: %v", err)
	}
	if first.Password == nil || second.Password == nil {
		t.Fatal("both resolutions must carry a password")
	}
	if *first.Password != *second.Password {
		t.Error("stored password must be stable across restarts")
	}
	if second.Source != CredentialSourceStored {
		t.Errorf("source = %q, want %q", second.Source, CredentialSourceStored)
	}
}

func TestCorruptSecretsFileIsReportedAndPreserved(t *testing.T) {
	dir := t.TempDir()
	file := writeRestricted(t, dir, SecretsFilename, "{not json")

	_, err := ResolveDatabaseCredentials(dir)
	var credentialErr *CredentialError
	if !errors.As(err, &credentialErr) {
		t.Fatalf("expected a CredentialError, got %v", err)
	}
	if credentialErr.Code != CredentialErrorInvalidSecretsFile {
		t.Errorf("code = %q, want %q", credentialErr.Code, CredentialErrorInvalidSecretsFile)
	}
	contents, readErr := os.ReadFile(file)
	if readErr != nil {
		t.Fatalf("re-reading the damaged secrets file: %v", readErr)
	}
	if string(contents) != "{not json" {
		t.Error("a damaged secrets file must be left untouched")
	}
}

func TestEncryptionKeyIsStableAndObfuscatedAtRest(t *testing.T) {
	dir := t.TempDir()
	first, err := EnsureEncryptionKey(dir)
	if err != nil {
		t.Fatalf("first key: %v", err)
	}
	second, err := EnsureEncryptionKey(dir)
	if err != nil {
		t.Fatalf("second key: %v", err)
	}
	if first != second {
		t.Error("encryption key must be stable")
	}
	if len(first) != EncryptionKeyBytes*2 {
		t.Errorf("key length = %d, want %d", len(first), EncryptionKeyBytes*2)
	}
	if !isLowerHex(first) {
		t.Errorf("key %q is not hexadecimal", first)
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

func TestEncryptionKeyOfTheWrongShapeIsRejected(t *testing.T) {
	dir := t.TempDir()
	writeRestricted(t, dir, KeyFilename, EncodeSecret("not-a-key"))

	_, err := EnsureEncryptionKey(dir)
	var credentialErr *CredentialError
	if !errors.As(err, &credentialErr) {
		t.Fatalf("expected a CredentialError, got %v", err)
	}
	if credentialErr.Code != CredentialErrorInvalidSecretValue {
		t.Errorf("code = %q, want %q", credentialErr.Code, CredentialErrorInvalidSecretValue)
	}
}

func TestCredentialEnvironmentCarriesThePassword(t *testing.T) {
	password := "s3cr3t"
	environment, err := BuildCredentialEnvironment(DatabaseCredentials{
		User:     DatabaseUser,
		Password: &password,
	})
	if err != nil {
		t.Fatalf("building the credential environment: %v", err)
	}
	if environment.SurrealUser != DatabaseUser {
		t.Errorf("SURREAL_USER = %q, want %q", environment.SurrealUser, DatabaseUser)
	}
	if environment.SurrealPassword != password || environment.SurrealPass != password {
		t.Error("both SURREAL_PASSWORD and SURREAL_PASS must carry the password")
	}
}

func TestCredentialEnvironmentRejectsUnprovisionedInstall(t *testing.T) {
	if _, err := BuildCredentialEnvironment(DatabaseCredentials{User: DatabaseUser}); err == nil {
		t.Error("an unmigrated install must not produce a usable credential environment")
	}
}

// TestEverySharedCredentialStateMatchesTheFixture replays each declared
// on-disk situation and compares the reported outcome with the contract.
func TestEverySharedCredentialStateMatchesTheFixture(t *testing.T) {
	cases := loadCredentialCases(t)
	if len(cases.States) == 0 {
		t.Fatal("the fixture declares no credential states")
	}
	for _, state := range cases.States {
		state := state
		t.Run(state.ID, func(t *testing.T) {
			dir := t.TempDir()
			secretsFile := filepath.Join(dir, SecretsFilename)
			switch state.Datastore {
			case "present":
				seedsLegacyDatastore(t, dir)
			case "unreadable":
				// A file where the datastore directory belongs cannot be
				// descended into, which makes the inspection fail portably.
				if err := os.WriteFile(filepath.Join(dir, DatabaseDirname), []byte("not a directory"), 0644); err != nil {
					t.Fatalf("seeding an unreadable datastore: %v", err)
				}
			}

			switch state.Secrets {
			case "valid":
				writeRestricted(t, dir, SecretsFilename, secretsContents(EncodeSecret("shared-fixture-secret")))
			case "corrupt":
				writeRestricted(t, dir, SecretsFilename, "{not json")
			case "missing-field":
				writeRestricted(t, dir, SecretsFilename, secretsContents(""))
			case "undecodable":
				writeRestricted(t, dir, SecretsFilename, secretsContents(ObfuscationPrefix+"!!!!"))
			case "empty":
				writeRestricted(t, dir, SecretsFilename, secretsContents(EncodeSecret("")))
			case "control-char":
				writeRestricted(t, dir, SecretsFilename, secretsContents(EncodeSecretWith("bad"+string(rune(7))+"secret", DeriveObfuscationKey())))
			}

			if state.ACL == "open" {
				widenACL(t, secretsFile)
			}

			before, beforeErr := os.ReadFile(secretsFile)

			credentials, err := ResolveDatabaseCredentials(dir)

			if state.Outcome == "rejected" {
				var credentialErr *CredentialError
				if !errors.As(err, &credentialErr) {
					t.Fatalf("expected a CredentialError, got %v", err)
				}
				if state.ErrorCode == nil || credentialErr.Code != *state.ErrorCode {
					t.Fatalf("code = %q, want %v", credentialErr.Code, state.ErrorCode)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected rejection (%v)", err)
				}
				if state.Source == nil || string(credentials.Source) != *state.Source {
					t.Fatalf("source = %q, want %v", credentials.Source, state.Source)
				}
				if credentials.Legacy != state.Legacy {
					t.Errorf("legacy = %v, want %v", credentials.Legacy, state.Legacy)
				}
				if (credentials.Password != nil) != state.PasswordAvailable {
					t.Errorf("password available = %v, want %v", credentials.Password != nil, state.PasswordAvailable)
				}
				if credentials.Password != nil && *credentials.Password == "" {
					t.Error("a reported password must not be empty")
				}
			}

			// No state ever rewrites the secrets file: an install must not
			// lose the only copy of a password the datastore still accepts.
			if beforeErr == nil && !state.WritesSecretsFile {
				after, err := os.ReadFile(secretsFile)
				if err != nil {
					t.Fatalf("re-reading the secrets file: %v", err)
				}
				if string(after) != string(before) {
					t.Error("the secrets file must not be rewritten")
				}
			}
			if state.Secrets == "absent" {
				_, statErr := os.Stat(secretsFile)
				if (statErr == nil) != state.WritesSecretsFile {
					t.Errorf("secrets file present = %v, want %v", statErr == nil, state.WritesSecretsFile)
				}
			}
		})
	}
}

// TestEverySharedACLSampleClassifiesAsTheFixtureSays replays the recorded
// icacls listings and POSIX modes.
func TestEverySharedACLSampleClassifiesAsTheFixtureSays(t *testing.T) {
	cases := loadCredentialCases(t)
	if len(cases.AclSamples) == 0 {
		t.Fatal("the fixture declares no ACL samples")
	}
	for _, sample := range cases.AclSamples {
		sample := sample
		t.Run(sample.ID, func(t *testing.T) {
			var restricted bool
			if sample.Mode != nil {
				restricted = IsRestrictedPosixMode(*sample.Mode)
			} else {
				restricted = IsRestrictedACLListing(sample.Icacls)
			}
			if restricted != sample.Restricted {
				t.Errorf("restricted = %v, want %v", restricted, sample.Restricted)
			}
		})
	}
}

// TestCredentialErrorCodesAndSourcesMatchTheFixture keeps the Go constants and
// the shared vocabulary from drifting apart.
func TestCredentialErrorCodesAndSourcesMatchTheFixture(t *testing.T) {
	cases := loadCredentialCases(t)
	declared := map[string]string{
		"invalidSecretsFile":  CredentialErrorInvalidSecretsFile,
		"invalidSecretValue":  CredentialErrorInvalidSecretValue,
		"permissionsTooOpen":  CredentialErrorPermissionsTooOpen,
		"datastoreUnreadable": CredentialErrorDatastoreUnreadable,
	}
	for name, value := range declared {
		want, ok := cases.ErrorCodes[name]
		if !ok {
			t.Fatalf("the fixture does not declare the error code %q", name)
		}
		if value != want {
			t.Errorf("error code %q = %q, want %q", name, value, want)
		}
	}

	for _, source := range []CredentialSource{
		CredentialSourceLegacyUnmigrated,
		CredentialSourceStored,
		CredentialSourceGenerated,
	} {
		found := false
		for _, declared := range cases.Sources {
			if string(source) == declared {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("source %q is not declared in the fixture", source)
		}
	}
	if CredentialSourceLegacyUnmigrated == "legacy" {
		t.Error("the unmigrated source must not be spelled \"legacy\"")
	}
}

// writeRestricted writes a file the way a shipped build would, so ACL cases
// stay independent of the parsing cases.
func writeRestricted(t *testing.T, dir, name, contents string) string {
	t.Helper()
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
		t.Fatalf("writing %s: %v", file, err)
	}
	if err := RestrictToCurrentUser(file); err != nil {
		t.Fatalf("restricting %s: %v", file, err)
	}
	return file
}

// widenACL makes a restricted file readable by every local account, which is
// the situation the host has to refuse to start in.
func widenACL(t *testing.T, file string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		// Granting Everyone read access by SID keeps this independent of the
		// machine's locale, which localises the *name* of this group.
		output, err := exec.Command("icacls", file, "/grant", "*S-1-1-0:(R)").CombinedOutput()
		if err != nil {
			t.Fatalf("widening the ACL of %s: %v (%s)", file, err, output)
		}
		return
	}
	if err := os.Chmod(file, 0644); err != nil {
		t.Fatalf("widening the mode of %s: %v", file, err)
	}
}

// seedsLegacyDatastore creates the on-disk shape of an install that predates
// per-install credentials.
func seedsLegacyDatastore(t *testing.T, dataDir string) {
	t.Helper()
	dir := filepath.Join(dataDir, DatabaseDirname)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("creating the datastore directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, DatabaseFilename), []byte("x"), 0644); err != nil {
		t.Fatalf("writing the datastore file: %v", err)
	}
}

// secretsContents renders a secrets file body, with an empty password omitted
// so the "missing-field" state is representable.
func secretsContents(encodedPassword string) string {
	body := map[string]string{"unrelated": "true"}
	if encodedPassword != "" {
		body = map[string]string{"surrealPassword": encodedPassword}
	}
	encoded, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		panic(err)
	}
	return string(encoded) + "\n"
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
