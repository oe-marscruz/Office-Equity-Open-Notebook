using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OfficeEquityOpenNotebook
{
    /// <summary>
    /// Where a resolved database password came from.
    /// </summary>
    public enum CredentialSource
    {
        /// <summary>The install predates per-install credentials and keeps root/root.</summary>
        Legacy,

        /// <summary>The password was read back from an existing secret store.</summary>
        Stored,

        /// <summary>The password was generated on this run.</summary>
        Generated,
    }

    /// <summary>
    /// The SurrealDB credentials to start the database with.
    /// </summary>
    public sealed class DatabaseCredentials
    {
        /// <summary>The SurrealDB user name.</summary>
        public string User { get; set; } = string.Empty;

        /// <summary>The SurrealDB password.</summary>
        public string Password { get; set; } = string.Empty;

        /// <summary>True when the install still uses the legacy root/root credential.</summary>
        public bool Legacy { get; set; }

        /// <summary>Where the password came from.</summary>
        public CredentialSource Source { get; set; }
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
    /// be locked out of its own data. Existing datastores therefore keep their
    /// original root password; only fresh installs receive a random one.
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

        /// <summary>The root password used by builds that predate per-install credentials.</summary>
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

        /// <summary>Decodes a stored secret value with the machine-bound key.</summary>
        public static string DecodeSecret(string stored)
        {
            return DecodeSecretWith(stored, DeriveObfuscationKey());
        }

        /// <summary>
        /// Restricts a file to the current OS user.
        ///
        /// This is best effort by design: a failure here must never stop the
        /// app from starting, so every error is swallowed.
        /// </summary>
        public static bool RestrictToCurrentUser(string file)
        {
            if (OperatingSystem.IsWindows())
            {
                string user = (Environment.GetEnvironmentVariable("USERNAME") ?? string.Empty).Trim();
                if (user.Length == 0)
                {
                    return false;
                }
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
            try
            {
                if (!File.Exists(file))
                {
                    return false;
                }
                File.SetUnixFileMode(
                    file,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite);
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Writes contents to a file and restricts it to the current OS user.</summary>
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
        /// True when dataDir already holds a SurrealDB datastore from an
        /// earlier run.
        ///
        /// RocksDB stores its datastore in a directory, which reports a size of
        /// 0 on Windows, so both shapes have to be checked.
        /// </summary>
        public static bool HasExistingDatastore(string dataDir)
        {
            string file = Path.Combine(dataDir, DatabaseDirname, DatabaseFilename);
            try
            {
                if (Directory.Exists(file))
                {
                    return Directory.EnumerateFileSystemEntries(file).Any();
                }
                if (File.Exists(file))
                {
                    return new FileInfo(file).Length > 0;
                }
            }
            catch
            {
                return false;
            }
            return false;
        }

        /// <summary>
        /// Returns the persisted database password for dataDir, generating one
        /// on first use.
        /// </summary>
        public static string EnsureDatabasePassword(string dataDir)
        {
            string secretsFile = Path.Combine(dataDir, SecretsFilename);
            if (File.Exists(secretsFile))
            {
                try
                {
                    string contents = File.ReadAllText(secretsFile, Encoding.UTF8);
                    using JsonDocument document = JsonDocument.Parse(contents);                    if (document.RootElement.TryGetProperty("surrealPassword", out JsonElement stored)
                        && stored.ValueKind == JsonValueKind.String
                        && stored.GetString() is { Length: > 0 } value)
                    {
                        return DecodeSecret(value);
                    }
                }
                catch (JsonException)
                {
                    // A corrupt secrets file is rewritten below rather than
                    // crashing startup.
                }
                catch (IOException)
                {
                    // Same as above: a corrupt or unreadable file is replaced.
                }
            }

            string password = RandomPassword();
            var payload = new Dictionary<string, string>
            {
                ["surrealPassword"] = EncodeSecret(password),
            };
            WriteSecretFile(secretsFile, JsonSerializer.Serialize(payload, SecretsJsonOptions) + "\n");
            return password;
        }

        /// <summary>Generates a random base64url password.</summary>
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
        /// SurrealDB applies the initial root credentials only when no root
        /// user exists yet, so a freshly generated password has no effect on a
        /// datastore created by an older build: the stored root credentials win
        /// and the backend would be locked out of its own data. Existing
        /// datastores therefore keep their original password so upgrades never
        /// lose notebook content; only new installs get a random one.
        /// </summary>
        public static DatabaseCredentials ResolveDatabaseCredentials(string dataDir)
        {
            string secretsFile = Path.Combine(dataDir, SecretsFilename);
            bool hadSecrets = File.Exists(secretsFile);

            if (HasExistingDatastore(dataDir) && !hadSecrets)
            {
                return new DatabaseCredentials
                {
                    User = DatabaseUser,
                    Password = LegacyDatabasePassword,
                    Legacy = true,
                    Source = CredentialSource.Legacy,
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
        /// Returns the persisted encryption key for dataDir, generating a
        /// random 32-byte key on first use.
        ///
        /// The key is stored obfuscated so it never appears in plaintext on
        /// disk. Legacy plaintext key files are still readable, but new keys
        /// use the obfuscated format.
        /// </summary>
        public static string EnsureEncryptionKey(string dataDir)
        {
            string keyFile = Path.Combine(dataDir, KeyFilename);
            if (File.Exists(keyFile))
            {
                string existing = DecodeSecret(File.ReadAllText(keyFile, Encoding.UTF8));
                if (existing.Length > 0)
                {
                    return existing;
                }
            }

            string key = Convert.ToHexString(RandomNumberGenerator.GetBytes(EncryptionKeyBytes)).ToLowerInvariant();
            WriteSecretFile(keyFile, EncodeSecret(key));
            return key;
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
        /// </summary>
        public static CredentialEnvironment BuildCredentialEnvironment(DatabaseCredentials credentials)
        {
            return new CredentialEnvironment
            {
                SurrealUser = credentials.User,
                SurrealPassword = credentials.Password,
                SurrealPass = credentials.Password,
            };
        }
    }
}
