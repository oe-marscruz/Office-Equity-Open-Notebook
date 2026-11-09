using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OfficeEquityOpenNotebook
{
    /// <summary>
    /// Where a resolved database password came from.
    ///
    /// These are the stable string identifiers of the cross-host contract; the
    /// names are asserted against <c>tests/contracts/credentials-cases.json</c>
    /// in every host's test suite.
    /// </summary>
    public enum CredentialSource
    {
        /// <summary>
        /// The install predates per-install credentials: a datastore exists and
        /// no secrets file does. No password is available until a migration
        /// runs, so callers have to handle this case explicitly.
        /// </summary>
        LegacyUnmigrated,

        /// <summary>The password was read back from an existing secret store.</summary>
        Stored,

        /// <summary>The password was generated on this run.</summary>
        Generated,
    }

    /// <summary>
    /// The stable <see cref="CredentialSource"/> identifiers.
    /// </summary>
    public static class CredentialSources
    {
        public const string LegacyUnmigrated = "legacy-unmigrated";
        public const string Stored = "stored";
        public const string Generated = "generated";

        /// <summary>Renders a source as its cross-host identifier.</summary>
        public static string ToIdentifier(CredentialSource source)
        {
            return source switch
            {
                CredentialSource.LegacyUnmigrated => LegacyUnmigrated,
                CredentialSource.Stored => Stored,
                CredentialSource.Generated => Generated,
                _ => throw new ArgumentOutOfRangeException(nameof(source)),
            };
        }
    }

    /// <summary>
    /// The stable error codes a <see cref="CredentialException"/> can carry.
    ///
    /// Launchers render host-appropriate guidance from the code rather than
    /// matching on message text, which keeps the wording free to change.
    /// </summary>
    public static class CredentialErrorCodes
    {
        public const string InvalidSecretsFile = "invalid-secrets-file";
        public const string InvalidSecretValue = "invalid-secret-value";
        public const string PermissionsTooOpen = "permissions-too-open";
        public const string DatastoreUnreadable = "datastore-unreadable";
    }

    /// <summary>
    /// Thrown when the credential store cannot be used safely.
    /// </summary>
    public sealed class CredentialException : Exception
    {
        public CredentialException(string message, string code, string? path = null)
            : base(message)
        {
            Code = code;
            Path = path;
        }

        /// <summary>One of the <see cref="CredentialErrorCodes"/> identifiers.</summary>
        public string Code { get; }

        /// <summary>The file or directory the failure concerns, when known.</summary>
        public string? Path { get; }
    }

    /// <summary>
    /// The SurrealDB credentials to start the database with.
    /// </summary>
    public sealed class DatabaseCredentials
    {
        /// <summary>The SurrealDB user name.</summary>
        public string User { get; set; } = string.Empty;

        /// <summary>
        /// The SurrealDB password, or null when the install is
        /// <see cref="CredentialSource.LegacyUnmigrated"/> and no password can
        /// be obtained without a migration.
        /// </summary>
        public string? Password { get; set; }

        /// <summary>True when the install needs an explicit credential migration.</summary>
        public bool Legacy { get; set; }

        /// <summary>Where the password came from.</summary>
        public CredentialSource Source { get; set; }

        /// <summary>The source as its cross-host identifier.</summary>
        public string SourceIdentifier => CredentialSources.ToIdentifier(Source);
    }

    /// <summary>
    /// The environment variables that carry database credentials to the
    /// SurrealDB server and the Python backend.
    /// </summary>
    public sealed class CredentialEnvironment
    {
        /// <summary>SURREAL_USER, read by both SurrealDB and the upstream backend.</summary>
        public string SurrealUser { get; set; } = string.Empty;

        /// <summary>SURREAL_PASSWORD, read by the upstream backend.</summary>
        public string SurrealPassword { get; set; } = string.Empty;

        /// <summary>SURREAL_PASS, read by the SurrealDB CLI.</summary>
        public string SurrealPass { get; set; } = string.Empty;

        /// <summary>Renders the environment as name/value pairs.</summary>
        public Dictionary<string, string> AsPairs()
        {
            return new Dictionary<string, string>
            {
                ["SURREAL_USER"] = SurrealUser,
                ["SURREAL_PASSWORD"] = SurrealPassword,
                ["SURREAL_PASS"] = SurrealPass,
            };
        }
    }

    /// <summary>
    /// Shared on-disk secret storage for the C#/WinUI host.
    ///
    /// This is the C# mirror of <c>scripts/lib/credentials.js</c>, which is the
    /// canonical implementation of the format. The Electron, Rust/Tauri and
    /// Go/Wails hosts implement the same on-disk layout, so a user data
    /// directory can be moved between hosts without losing the database
    /// credentials or the provider-API-key encryption key.
    ///
    /// Security model
    /// --------------
    /// A fixed root/root credential on a loopback-bound service is not a
    /// defense: any other process or account on the machine can reach the
    /// local port and read the whole notebook database. Each install therefore
    /// gets its own randomly generated database password.
    ///
    /// Secrets are stored obfuscated (XOR with a machine-and-user-bound
    /// derivation) rather than in plaintext, and the files are restricted to the
    /// current OS user via ACLs. This is deliberately not presented as
    /// equivalent to a hardware-backed key store; it raises the bar against
    /// casual reads by other processes. It does not defend against an attacker
    /// who already runs as the current user.
    ///
    /// Legacy installs
    /// ---------------
    /// SurrealDB applies the initial root credentials only when no root user
    /// exists yet. A datastore created by an older build already has a root
    /// user, so a newly generated password has no effect and the backend would
    /// be locked out of its own data. A datastore that has no secrets file is
    /// therefore reported as <see cref="CredentialSource.LegacyUnmigrated"/>
    /// with a null password, and every caller has to handle the migration
    /// explicitly. Handing back the legacy `root` password instead is what
    /// made the condition invisible.
    ///
    /// Cross-language on-disk contract
    /// -------------------------------
    /// These details are byte-for-byte identical in the JavaScript, Rust and Go
    /// hosts and must not drift:
    ///
    /// * Obfuscation key: SHA-256("Office-Equity-Open-Notebook|&lt;username&gt;|&lt;hostname&gt;")
    ///   over the UTF-8 joined string, with the domain qualifier stripped from
    ///   the user name.
    /// * Obfuscated value: "obf:" followed by standard base64 of
    ///   XOR(utf8(secret), key).
    /// * encryption-key.txt: the obfuscated 32-byte key, hex encoded.
    /// * secrets.json: {"surrealPassword": "&lt;value&gt;"}, two-space indent and a
    ///   trailing newline.
    /// * Legacy values without the "obf:" prefix are plaintext and are returned
    ///   unchanged.
    /// </summary>
    public static class Credentials
    {
        /// <summary>File holding the obfuscated provider-API-key encryption key.</summary>
        public const string KeyFilename = "encryption-key.txt";

        /// <summary>File holding the obfuscated SurrealDB root password.</summary>
        public const string SecretsFilename = "secrets.json";

        /// <summary>
        /// The fixed password written by builds that predate per-install
        /// credentials.
        ///
        /// Retained only so the migration path can explicitly ask to try it
        /// once against an existing datastore. No resolution path returns this
        /// value: <see cref="ResolveDatabaseCredentials"/> reports
        /// <see cref="CredentialSource.LegacyUnmigrated"/> with a null password
        /// instead, so a caller that forgets to handle migration fails loudly
        /// rather than quietly connecting as root.
        /// </summary>
        public const string LegacyDatabasePassword = "root";

        /// <summary>The SurrealDB root username. Fixed, because it is not itself a secret.</summary>
        public const string DatabaseUser = "root";

        /// <summary>Directory name of the SurrealDB datastore, relative to the data dir.</summary>
        public const string DatabaseDirname = "surrealdb";

        /// <summary>File name of the SurrealDB datastore, relative to the data dir.</summary>
        public const string DatabaseFilename = "mydatabase.db";

        /// <summary>Marker prefix identifying an obfuscated value in a secret file.</summary>
        public const string ObfuscationPrefix = "obf:";

        /// <summary>App-specific salt mixed into the obfuscation key derivation.</summary>
        public const string ObfuscationSalt = "Office-Equity-Open-Notebook";

        /// <summary>Length in bytes of the generated encryption key.</summary>
        public const int EncryptionKeyBytes = 32;

        /// <summary>Length in bytes of the generated database password.</summary>
        public const int DatabasePasswordBytes = 24;

        /// <summary>
                /// UTF-8 without a byte-order mark.
                ///
                /// The cross-language on-disk contract requires the exact bytes the
                /// JavaScript, Rust and Go hosts write, and a BOM would make the
                /// stored value undecodable elsewhere.
                /// </summary>
                private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

                private static readonly JsonSerializerOptions SecretsJsonOptions = new()
                {
                    WriteIndented = true,
                };

        /// <summary>
        /// Removes a domain qualifier from an account name.
        ///
        /// Windows APIs disagree about whether the account name is
        /// domain-qualified: GetUserNameW reports "cruzmars" while Go's
        /// user.Current reports "UNIVERSITY\cruzmars". The obfuscation key has
        /// to be identical across all hosts, so the domain qualifier is removed
        /// everywhere.
        /// </summary>
        public static string StripUserDomain(string? name)
        {
            string raw = (name ?? string.Empty).Trim();
            if (raw.Length == 0)
            {
                return string.Empty;
            }
            int cut = Math.Max(raw.LastIndexOf('\\'), raw.LastIndexOf('/'));
            return cut >= 0 ? raw.Substring(cut + 1).Trim() : raw;
        }

        /// <summary>
        /// The current OS user name, or an empty string when it cannot be
        /// determined.
        ///
        /// The environment is consulted first because every host can read it,
        /// whereas the OS account APIs differ in what they return. The order is
        /// fixed so that all hosts resolve the same value: USERNAME, then USER,
        /// then the OS account API.
        /// </summary>
        public static string CurrentUsername()
        {
            foreach (string key in new[] { "USERNAME", "USER" })
            {
                string fromEnv = StripUserDomain(Environment.GetEnvironmentVariable(key));
                if (fromEnv.Length > 0)
                {
                    return fromEnv;
                }
            }
            try
            {
                string fromApi = StripUserDomain(Environment.UserName);
                if (fromApi.Length > 0)
                {
                    return fromApi;
                }
            }
            catch
            {
                // Environment.UserName can fail in restricted sandboxes.
            }
            return string.Empty;
        }

        /// <summary>
        /// The current machine name, or an empty string when it cannot be
        /// determined.
        ///
        /// The order is fixed so that all hosts resolve the same value:
        /// COMPUTERNAME, then HOSTNAME, then the OS API.
        /// </summary>
        public static string CurrentHostname()
        {
            foreach (string key in new[] { "COMPUTERNAME", "HOSTNAME" })
            {
                string fromEnv = (Environment.GetEnvironmentVariable(key) ?? string.Empty).Trim();
                if (fromEnv.Length > 0)
                {
                    return fromEnv;
                }
            }
            try
            {
                string fromApi = Environment.MachineName.Trim();
                if (fromApi.Length > 0)
                {
                    return fromApi;
                }
            }
            catch
            {
                // Environment.MachineName can fail in restricted sandboxes.
            }
            return string.Empty;
        }

        /// <summary>
        /// Derives the obfuscation key for the current account and machine.
        /// </summary>
        public static byte[] DeriveObfuscationKey()
        {
            return DeriveObfuscationKeyFrom(CurrentUsername(), CurrentHostname());
        }

        /// <summary>
        /// Derives the obfuscation key for an explicit account and machine name.
        ///
        /// Exposed so that the cross-language parity tests can check a fixed
        /// vector instead of depending on the machine the tests happen to run on.
        /// </summary>
        public static byte[] DeriveObfuscationKeyFrom(string username, string hostname)
        {
            string joined = $"{ObfuscationSalt}|{username}|{hostname}";
            return SHA256.HashData(Encoding.UTF8.GetBytes(joined));
        }

        /// <summary>
        /// Obfuscates data with the machine-bound key.
        ///
        /// The transform is symmetric: applying it twice restores the original
        /// bytes.
        /// </summary>
        public static byte[] XorObfuscate(byte[] data, byte[] key)
        {
            if (key.Length == 0)
            {
                return (byte[])data.Clone();
            }
            byte[] output = new byte[data.Length];
            for (int i = 0; i < data.Length; i++)
            {
                output[i] = (byte)(data[i] ^ key[i % key.Length]);
            }
            return output;
        }

        /// <summary>Obfuscates a secret and encodes it for storage.</summary>
        public static string EncodeSecretWith(string secret, byte[] key)
        {
            byte[] obfuscated = XorObfuscate(Encoding.UTF8.GetBytes(secret), key);
            return ObfuscationPrefix + Convert.ToBase64String(obfuscated);
        }

        /// <summary>
        /// Decodes a stored secret value against an explicit key.
        ///
        /// Values written before the obfuscated format existed are stored in
        /// plaintext and are returned unchanged, so existing installs keep
        /// working.
        /// </summary>
        public static string DecodeSecretWith(string stored, byte[] key)
        {
            string raw = (stored ?? string.Empty).Trim();
            if (!raw.StartsWith(ObfuscationPrefix, StringComparison.Ordinal))
            {
                return raw;
            }
            byte[] obfuscated;
            try
            {
                obfuscated = Convert.FromBase64String(raw.Substring(ObfuscationPrefix.Length));
            }
            catch (FormatException)
            {
                return raw;
            }
            return Encoding.UTF8.GetString(XorObfuscate(obfuscated, key));
        }

        /// <summary>Obfuscates a secret with the machine-bound key and encodes it.</summary>
        public static string EncodeSecret(string secret)
        {
            return EncodeSecretWith(secret, DeriveObfuscationKey());
        }

        /// <summary>
        /// Decodes a stored secret value with the machine-bound key.
        ///
        /// Values written before the obfuscated format existed are stored in
        /// plaintext and are returned unchanged, so existing installs keep
        /// working.
        /// </summary>
        public static string DecodeSecret(string stored)
        {
            return DecodeSecretWith(stored, DeriveObfuscationKey());
        }

        /// <summary>
        /// Decodes a stored secret value with validation.
        ///
        /// Mirrors the Rust <c>decode_checked</c> and the JavaScript
        /// <c>decodeSecretChecked</c>: a value carrying the obfuscation prefix
        /// must be strict base64, must decode to valid UTF-8, and must be a
        /// non-empty string free of control characters. Anything else is
        /// reported rather than passed on, because a mangled password produces
        /// an unactionable connection failure much later in startup.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The stored value cannot be decoded into a usable secret.
        /// </exception>
        public static string DecodeSecretChecked(string stored)
        {
            string raw = (stored ?? string.Empty).Trim();
            string decoded;
            if (raw.StartsWith(ObfuscationPrefix, StringComparison.Ordinal))
            {
                string payload = raw.Substring(ObfuscationPrefix.Length);
                if (!IsStrictBase64(payload, out byte[] bytes))
                {
                    throw new CredentialException("Invalid encoded credential", CredentialErrorCodes.InvalidSecretValue);
                }
                bytes = XorObfuscate(bytes, DeriveObfuscationKey());
                if (!TryDecodeUtf8Strict(bytes, out decoded))
                {
                    throw new CredentialException("Invalid credential encoding", CredentialErrorCodes.InvalidSecretValue);
                }
            }
            else
            {
                decoded = raw;
            }
            if (!IsUsableSecretValue(decoded))
            {
                throw new CredentialException("Invalid credential value", CredentialErrorCodes.InvalidSecretValue);
            }
            return decoded;
        }

        /// <summary>
        /// True when <paramref name="value"/> is a non-empty string without
        /// control characters.
        ///
        /// A control character cannot survive a process environment or a CLI
        /// argument, so such a value can never be a working password.
        /// </summary>
        public static bool IsUsableSecretValue(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }
            foreach (char c in value)
            {
                if (c < 0x20 || (c >= 0x7f && c <= 0x9f))
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// True when <paramref name="value"/> is base64 that round-trips
        /// unchanged.
        ///
        /// <see cref="Convert.FromBase64String(string)"/> throws on invalid
        /// input, but it tolerates several non-canonical encodings, so the
        /// round-trip comparison is what makes the check strict. A corrupted
        /// payload would otherwise decode to a plausible-looking wrong secret.
        /// </summary>
        private static bool IsStrictBase64(string value, out byte[] bytes)
        {
            bytes = Array.Empty<byte>();
            if (value.Length == 0)
            {
                return false;
            }
            foreach (char c in value.TrimEnd('='))
            {
                bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '+' || c == '/';
                if (!ok)
                {
                    return false;
                }
            }
            if (value.Length % 4 != 0)
            {
                return false;
            }
            try
            {
                bytes = Convert.FromBase64String(value);
            }
            catch (FormatException)
            {
                return false;
            }
            return Convert.ToBase64String(bytes) == value;
        }

        /// <summary>
        /// Decodes UTF-8 without substituting replacement characters.
        ///
        /// <see cref="Encoding.UTF8"/> replaces invalid sequences with U+FFFD
        /// unless it is told to throw, so a corrupted payload would otherwise
        /// look like a valid secret that merely contains odd glyphs.
        /// </summary>
        private static bool TryDecodeUtf8Strict(byte[] bytes, out string decoded)
        {
            try
            {
                decoded = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes);
                return true;
            }
            catch (DecoderFallbackException)
            {
                decoded = string.Empty;
                return false;
            }
        }

        /// <summary>
        /// Reports whether an <c>icacls</c> listing proves the file is readable
        /// by exactly one non-inherited entry.
        ///
        /// An inherited entry means the parent directory's accounts keep their
        /// access, which is exactly what the restriction exists to remove, and
        /// no entry at all means the ACL could not be read.
        /// </summary>
        public static bool IsRestrictedAclListing(string? output)
        {
            if (output == null)
            {
                return false;
            }
            var aceLines = new List<string>();
            foreach (string rawLine in output.Split('\n'))
            {
                string line = rawLine.Trim();
                if (line.Length == 0
                    || line.StartsWith("Successfully processed", StringComparison.Ordinal)
                    || line.StartsWith("Failed processing", StringComparison.Ordinal)
                    || line.StartsWith("The trust relationship", StringComparison.Ordinal)
                    // A mandatory integrity label is not a DACL entry; it
                    // appears when the process is elevated.
                    || line.StartsWith("Mandatory Label", StringComparison.Ordinal))
                {
                    continue;
                }
                aceLines.Add(line);
            }
            // `icacls` lists one ACE per line, so a restricted file has exactly one.
            if (aceLines.Count != 1)
            {
                return false;
            }
            string ace = aceLines[0];
            if (ace.Contains("(I)", StringComparison.Ordinal))
            {
                return false;
            }
            return ace.EndsWith("(F)", StringComparison.Ordinal);
        }

        /// <summary>
        /// Reports whether a POSIX mode is owner-only.
        ///
        /// Only the group and other bits are considered, exactly as the Rust
        /// <c>is_restricted_posix_mode</c> and the JavaScript
        /// <c>isRestrictedPosixMode</c> do, so the three hosts agree on every
        /// value the fixture carries.
        /// </summary>
        public static bool IsRestrictedPosixMode(int mode)
        {
            return (mode & 0x3F) == 0;
        }

        /// <summary>
        /// Restricts a file to the current OS user and proves that it took
        /// effect.
        ///
        /// Unlike a best-effort <c>chmod</c>, this re-reads the resulting ACL
        /// and fails when the file is still readable by another principal. The
        /// two files this protects hold the key that decrypts every stored
        /// provider API key and the database password, so "we tried" is not an
        /// acceptable answer.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The file could not be proven owner-only afterwards.
        /// </exception>
        public static void RestrictToCurrentUser(string file)
        {
            bool applied;
            if (OperatingSystem.IsWindows())
            {
                string user = (Environment.GetEnvironmentVariable("USERNAME") ?? string.Empty).Trim();
                applied = user.Length > 0 && TryGrantExclusiveAccess(file, user);
            }
            else
            {
                try
                {
                    File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                    applied = true;
                }
                catch
                {
                    applied = false;
                }
            }
            if (!applied || !CheckRestrictedToCurrentUser(file))
            {
                throw new CredentialException(
                    $"Could not restrict {Path.GetFileName(file)} to the current user",
                    CredentialErrorCodes.PermissionsTooOpen,
                    file);
            }
        }

        private static bool TryGrantExclusiveAccess(string file, string user)
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = "icacls",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                startInfo.ArgumentList.Add(file);
                startInfo.ArgumentList.Add("/inheritance:r");
                startInfo.ArgumentList.Add("/grant:r");
                startInfo.ArgumentList.Add($"{user}:F");
                using var process = Process.Start(startInfo);
                if (process == null)
                {
                    return false;
                }
                process.WaitForExit();
                return process.ExitCode == 0;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Reports whether <paramref name="file"/> is currently readable only
        /// by the current OS user.
        ///
        /// This is the enforced check: writers call it after restricting, and
        /// readers call it before trusting an existing file, so a secrets file
        /// left world readable by a previous release or by a manual copy is
        /// caught on next start.
        /// </summary>
        public static bool CheckRestrictedToCurrentUser(string file)
        {
            try
            {
                if (OperatingSystem.IsWindows())
                {
                    var startInfo = new ProcessStartInfo
                    {
                        FileName = "icacls",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                    };
                    startInfo.ArgumentList.Add(file);
                    using var process = Process.Start(startInfo);
                    if (process == null)
                    {
                        return false;
                    }
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit();
                    if (process.ExitCode != 0)
                    {
                        return false;
                    }
                    return IsRestrictedAclListing(output);
                }
                int mode = (int)File.GetUnixFileMode(file);
                return IsRestrictedPosixMode(mode);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Writes contents to a file and enforces the owner-only restriction.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The file could not be proven owner-only afterwards.
        /// </exception>
        private static void WriteSecretFile(string file, string contents)
        {
            string? directory = Path.GetDirectoryName(file);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }
            File.WriteAllText(file, contents, Utf8NoBom);
            RestrictToCurrentUser(file);
        }

        /// <summary>
        /// Reads a secrets file, enforcing that it is owner-only.
        ///
        /// The permission check happens before the contents are used so a
        /// secret that another account may already have read is never treated
        /// as trustworthy.
        /// </summary>
        /// <returns>The contents, or null when the file is absent.</returns>
        private static string? ReadProtectedSecretFile(string file)
        {
            string contents;
            try
            {
                contents = File.ReadAllText(file, Utf8NoBom);
            }
            catch (FileNotFoundException)
            {
                return null;
            }
            catch (DirectoryNotFoundException)
            {
                return null;
            }
            catch (IOException)
            {
                throw new CredentialException(
                    "Could not read credential file",
                    CredentialErrorCodes.InvalidSecretsFile,
                    file);
            }
            catch (UnauthorizedAccessException)
            {
                throw new CredentialException(
                    "Could not read credential file",
                    CredentialErrorCodes.InvalidSecretsFile,
                    file);
            }
            if (!CheckRestrictedToCurrentUser(file))
            {
                throw new CredentialException(
                    $"{Path.GetFileName(file)} is readable by accounts other than the current user",
                    CredentialErrorCodes.PermissionsTooOpen,
                    file);
            }
            return contents;
        }

        /// <summary>
        /// True when dataDir already holds a SurrealDB datastore from an
        /// earlier run.
        ///
        /// RocksDB stores its datastore in a directory, which reports a size of
        /// 0 on Windows, so both shapes have to be checked.
        ///
        /// The answer decides whether a missing secrets file is a fresh install
        /// or a legacy one, so an inspection error is reported rather than read
        /// as "no datastore": guessing there would overwrite a live
        /// installation's password.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The datastore path exists but cannot be inspected.
        /// </exception>
        public static bool HasExistingDatastore(string dataDir)
        {
            string dbDir = Path.Combine(dataDir, DatabaseDirname);
            string file = Path.Combine(dbDir, DatabaseFilename);
            // A datastore path occupied by something other than a directory
            // cannot be inspected. Windows reports this shape as "not found"
            // all the way down, which would otherwise be indistinguishable from
            // a fresh install.
            if (File.Exists(dbDir))
            {
                throw new CredentialException("Could not inspect datastore", CredentialErrorCodes.DatastoreUnreadable, dbDir);
            }
            if (Directory.Exists(file))
            {
                try
                {
                    return Directory.EnumerateFileSystemEntries(file).Any();
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                {
                    throw new CredentialException("Could not inspect datastore", CredentialErrorCodes.DatastoreUnreadable, file);
                }
            }
            if (File.Exists(file))
            {
                try
                {
                    return new FileInfo(file).Length > 0;
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                {
                    throw new CredentialException("Could not inspect datastore", CredentialErrorCodes.DatastoreUnreadable, file);
                }
            }
            // The file is absent. The directory itself still has to be
            // inspectable: a directory that exists but cannot be listed hides a
            // legacy datastore just as effectively as an unreadable file does.
            if (Directory.Exists(dbDir))
            {
                try
                {
                    Directory.EnumerateFileSystemEntries(dbDir).Any();
                }
                catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
                {
                    throw new CredentialException("Could not inspect datastore", CredentialErrorCodes.DatastoreUnreadable, dbDir);
                }
            }
            return false;
        }

        /// <summary>
        /// Returns the persisted database password for dataDir, generating one
        /// on first use.
        ///
        /// A secrets file that cannot be parsed or decoded is reported and left
        /// untouched: it may still hold the only copy of the password the
        /// datastore accepts, and rewriting it would turn a recoverable problem
        /// into a lockout. The legacy-unmigrated case is signalled by
        /// <see cref="ResolveDatabaseCredentials"/>, not here.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The stored credential cannot be trusted or no password can be
        /// generated.
        /// </exception>
        public static string EnsureDatabasePassword(string dataDir)
        {
            string secretsFile = Path.Combine(dataDir, SecretsFilename);
            string? contents = ReadProtectedSecretFile(secretsFile);
            if (contents != null)
            {
                string stored;
                try
                {
                    using JsonDocument document = JsonDocument.Parse(contents);
                    if (!document.RootElement.TryGetProperty("surrealPassword", out JsonElement value)
                        || value.ValueKind != JsonValueKind.String
                        || value.GetString() is not { Length: > 0 } parsed)
                    {
                        throw new CredentialException(
                            "Invalid database credential file",
                            CredentialErrorCodes.InvalidSecretsFile,
                            secretsFile);
                    }
                    stored = parsed;
                }
                catch (JsonException)
                {
                    throw new CredentialException(
                        "Invalid database credential file",
                        CredentialErrorCodes.InvalidSecretsFile,
                        secretsFile);
                }
                return DecodeSecretChecked(stored);
            }
            if (HasExistingDatastore(dataDir))
            {
                throw new CredentialException(
                    "Existing datastore has no credential file; recovery is required",
                    CredentialErrorCodes.InvalidSecretsFile,
                    secretsFile);
            }
            string password = RandomPassword();
            var payload = new Dictionary<string, string>
            {
                ["surrealPassword"] = EncodeSecret(password),
            };
            WriteSecretFile(secretsFile, JsonSerializer.Serialize(payload, SecretsJsonOptions) + "\n");
            return password;
        }

        /// <summary>
        /// Generates a random base64url password.
        ///
        /// A random-source failure stops startup rather than falling back to a
        /// deterministic value, because a placeholder would be a publicly known
        /// password on a loopback service.
        /// </summary>
        private static string RandomPassword()
        {
            byte[] buffer = RandomNumberGenerator.GetBytes(DatabasePasswordBytes);
            return Convert.ToBase64String(buffer)
                .TrimEnd('=')
                .Replace('+', '-')
                .Replace('/', '_');
        }

        /// <summary>
        /// Resolves the SurrealDB credentials to start the database with.
        ///
        /// SurrealDB applies the initial root credentials only when no root user
        /// exists yet, so a freshly generated password has no effect on a
        /// datastore created by an older build. Every host therefore reports one
        /// of three states:
        ///
        ///   - <see cref="CredentialSource.Generated"/> — fresh install,
        ///     random password created.
        ///   - <see cref="CredentialSource.Stored"/> — password read back from
        ///     <c>secrets.json</c>.
        ///   - <see cref="CredentialSource.LegacyUnmigrated"/> — datastore
        ///     exists, no secrets file. The install predates per-install
        ///     credentials and needs an explicit migration; no password is
        ///     returned.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The credential state cannot be established safely.
        /// </exception>
        public static DatabaseCredentials ResolveDatabaseCredentials(string dataDir)
        {
            string secretsFile = Path.Combine(dataDir, SecretsFilename);
            bool hadSecrets = File.Exists(secretsFile);

            if (!hadSecrets && HasExistingDatastore(dataDir))
            {
                return new DatabaseCredentials
                {
                    User = DatabaseUser,
                    Password = null,
                    Legacy = true,
                    Source = CredentialSource.LegacyUnmigrated,
                };
            }

            string password = EnsureDatabasePassword(dataDir);
            return new DatabaseCredentials
            {
                User = DatabaseUser,
                Password = password,
                Legacy = false,
                Source = hadSecrets ? CredentialSource.Stored : CredentialSource.Generated,
            };
        }

        /// <summary>
        /// Returns the persisted encryption key for dataDir, generating a random
        /// 32-byte key on first use.
        ///
        /// The key is stored obfuscated so it never appears in plaintext on
        /// disk. Legacy plaintext key files are still readable, but any stored
        /// key must have the documented shape: decrypting every saved provider
        /// API key with a truncated or non-hex value would fail long after
        /// startup reported success.
        /// </summary>
        /// <exception cref="CredentialException">
        /// The stored key is unusable or no key can be generated.
        /// </exception>
        public static string EnsureEncryptionKey(string dataDir)
        {
            string keyFile = Path.Combine(dataDir, KeyFilename);
            string? contents = ReadProtectedSecretFile(keyFile);
            if (contents != null)
            {
                string existing = DecodeSecretChecked(contents);
                if (existing.Length != EncryptionKeyBytes * 2 || !IsLowerHex(existing))
                {
                    throw new CredentialException(
                        "Invalid encryption key",
                        CredentialErrorCodes.InvalidSecretValue,
                        keyFile);
                }
                return existing;
            }
            if (HasExistingDatastore(dataDir))
            {
                throw new CredentialException(
                    "Existing datastore has no encryption key; recovery is required",
                    CredentialErrorCodes.InvalidSecretsFile,
                    keyFile);
            }
            string key = Convert.ToHexString(RandomNumberGenerator.GetBytes(EncryptionKeyBytes)).ToLowerInvariant();
            WriteSecretFile(keyFile, EncodeSecret(key));
            return key;
        }

        private static bool IsLowerHex(string value)
        {
            foreach (char c in value)
            {
                bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                if (!ok)
                {
                    return false;
                }
            }
            return value.Length > 0;
        }

        /// <summary>
        /// Builds the environment variables that carry the database credentials
        /// to the SurrealDB server and the Python backend.
        ///
        /// SurrealDB's own CLI reads SURREAL_USER and SURREAL_PASS. The
        /// upstream backend reads SURREAL_USER and SURREAL_PASSWORD, falling
        /// back to SURREAL_PASS. Both are therefore set to the same value.
        ///
        /// The credentials are passed through the process environment rather
        /// than the command line so they never appear in the process listing.
        ///
        /// A missing password is an error, not a default. Substituting the
        /// legacy root password here is what previously made the legacy case
        /// invisible.
        /// </summary>
        /// <exception cref="CredentialException">
        /// No usable password is available, which means the credential
        /// migration has not run.
        /// </exception>
        public static CredentialEnvironment BuildCredentialEnvironment(DatabaseCredentials credentials)
        {
            if (credentials == null)
            {
                throw new ArgumentNullException(nameof(credentials));
            }
            if (!IsUsableSecretValue(credentials.Password))
            {
                throw new CredentialException(
                    "No database password available; credential migration is required",
                    CredentialErrorCodes.InvalidSecretValue);
            }
            string user = credentials.User.Length > 0 ? credentials.User : DatabaseUser;
            return new CredentialEnvironment
            {
                SurrealUser = user,
                SurrealPassword = credentials.Password!,
                SurrealPass = credentials.Password!,
            };
        }
    }
}
