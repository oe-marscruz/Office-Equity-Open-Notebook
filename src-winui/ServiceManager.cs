using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OfficeEquityOpenNotebook
{
    public class ServiceConfig
    {
        public string Name { get; set; } = string.Empty;
        public string Executable { get; set; } = string.Empty;
        public List<string> Args { get; set; } = new();
        public string Cwd { get; set; } = string.Empty;
        public Dictionary<string, string> Env { get; set; } = new();
        public int ReadinessPort { get; set; }
        public bool Critical { get; set; } = true;
        public int TimeoutSec { get; set; } = 30;
    }

    public class RunningService
    {
        public ServiceConfig Config { get; }
        public Process Process { get; }

        public RunningService(ServiceConfig config, Process process)
        {
            Config = config;
            Process = process;
        }
    }

    public class ServiceManager
    {
        public string RuntimePath { get; }
        public string DataDir { get; }
        public string LogDir { get; }

        private readonly List<RunningService> _services = new();
        private readonly object _lock = new();

        public ServiceManager(string runtimePath, string dataDir, string logDir)
        {
            RuntimePath = runtimePath;
            DataDir = dataDir;
            LogDir = logDir;

            Directory.CreateDirectory(DataDir);
            Directory.CreateDirectory(LogDir);
        }

        public static string ResolveRuntimePath()
        {
            string baseDir = AppContext.BaseDirectory;
            string prodPath = Path.Combine(baseDir, "resources", "runtime");
            if (Directory.Exists(prodPath))
            {
                return prodPath;
            }
            return Path.GetFullPath(Path.Combine(".", "resources", "runtime"));
        }

        public static List<string> CheckMissingFiles(string runtimePath)
        {
            var missing = new List<string>();
            string[] required = new[]
            {
                Path.Combine(runtimePath, "surreal", "surreal.exe"),
                Path.Combine(runtimePath, "backend", "open_notebook"),
                Path.Combine(runtimePath, "frontend", "server.js"),
                Path.Combine(runtimePath, "manifest.json")
            };

            foreach (var req in required)
            {
                if (!File.Exists(req))
                {
                    missing.Add(req);
                }
            }
            return missing;
        }

        public static bool IsPortOpen(int port)
        {
            try
            {
                using var client = new TcpClient();
                var result = client.BeginConnect("127.0.0.1", port, null, null);
                bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(1));
                if (success)
                {
                    client.EndConnect(result);
                    return true;
                }
                return false;
            }
            catch
            {
                return false;
            }
        }

        public static async Task<bool> WaitForPortAsync(int port, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow.Add(timeout);
            while (DateTime.UtcNow < deadline)
            {
                if (IsPortOpen(port)) return true;
                await Task.Delay(250);
            }
            return false;
        }

        public async Task StartServicesAsync()
        {
            lock (_lock)
            {
                _services.Clear();
            }

            string backendPath = Path.Combine(RuntimePath, "backend");
            string surrealDbFile = Path.Combine(DataDir, "surrealdb", "mydatabase.db");
            Directory.CreateDirectory(Path.GetDirectoryName(surrealDbFile)!);

            // Resolve the per-install database credentials and the provider-API-key
            // encryption key. The credentials travel through the child environment
            // rather than the command line so they never appear in a process listing.
            //
            // ResolveDatabaseCredentials throws rather than falling back to the
            // legacy root password: a datastore without a secrets file needs an
            // explicit migration, and a damaged file may still hold the only copy
            // of the password the datastore accepts. Starting anyway would either
            // silently use a publicly known password or overwrite that copy.
            DatabaseCredentials credentials = Credentials.ResolveDatabaseCredentials(DataDir);
            if (credentials.Source == CredentialSource.LegacyUnmigrated)
            {
                throw new CredentialException(
                    "Credential migration is required for this installation",
                    CredentialErrorCodes.InvalidSecretsFile,
                    DataDir);
            }
            CredentialEnvironment credentialEnv = Credentials.BuildCredentialEnvironment(credentials);
            string encryptionKey = Credentials.EnsureEncryptionKey(DataDir);

            var backendEnv = new Dictionary<string, string>
            {
                ["OPEN_NOTEBOOK_ENCRYPTION_KEY"] = encryptionKey,
                ["SURREAL_URL"] = "ws://127.0.0.1:8000/rpc",
                ["SURREAL_NAMESPACE"] = "open_notebook",
                ["SURREAL_DATABASE"] = "open_notebook",
            };
            foreach (var pair in credentialEnv.AsPairs())
            {
                backendEnv[pair.Key] = pair.Value;
            }

            var configs = new List<ServiceConfig>
            {
                new ServiceConfig
                {
                    Name = "surrealdb",
                    Executable = Path.Combine(RuntimePath, "surreal", "surreal.exe"),
                    Args = new List<string> { "start", "--log", "info", "--bind", "127.0.0.1:8000", $"rocksdb:{surrealDbFile}" },
                    Cwd = RuntimePath,
                    Env = backendEnv,
                    ReadinessPort = 8000,
                    TimeoutSec = 60
                },
                new ServiceConfig
                {
                    Name = "api",
                    Executable = Path.Combine(RuntimePath, "python", "python.exe"),
                    Args = new List<string> { "-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", "5055" },
                    Cwd = backendPath,
                    Env = backendEnv,
                    ReadinessPort = 5055,
                    TimeoutSec = 120
                },
                new ServiceConfig
                {
                    Name = "worker",
                    Executable = Path.Combine(RuntimePath, "python", "python.exe"),
                    Args = new List<string> { "-m", "surreal_commands.cli.worker", "--import-modules", "commands", "--max-tasks", "2" },
                    Cwd = backendPath,
                    Env = backendEnv,
                    ReadinessPort = 0, // Process liveness
                    TimeoutSec = 30
                },
                new ServiceConfig
                {
                    Name = "frontend",
                    Executable = Path.Combine(RuntimePath, "node", "node.exe"),
                    Args = new List<string> { "server.js" },
                    Cwd = Path.Combine(RuntimePath, "frontend"),
                    Env = new Dictionary<string, string>
                    {
                        { "PORT", "8502" },
                        { "HOSTNAME", "127.0.0.1" },
                        { "INTERNAL_API_URL", "http://127.0.0.1:5055" }
                    },
                    ReadinessPort = 8502,
                    TimeoutSec = 120
                }
            };

            foreach (var cfg in configs)
            {
                var running = SpawnService(cfg);
                lock (_lock)
                {
                    _services.Add(running);
                }

                if (cfg.ReadinessPort > 0)
                {
                    bool ready = await WaitForPortAsync(cfg.ReadinessPort, TimeSpan.FromSeconds(cfg.TimeoutSec));
                    if (!ready)
                    {
                        throw new InvalidOperationException($"Readiness check failed for service '{cfg.Name}' on port {cfg.ReadinessPort}");
                    }
                }
            }
        }

        private RunningService SpawnService(ServiceConfig cfg)
        {
            var psi = new ProcessStartInfo
            {
                FileName = cfg.Executable,
                WorkingDirectory = cfg.Cwd,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            foreach (var arg in cfg.Args)
            {
                psi.ArgumentList.Add(arg);
            }

            foreach (var kv in cfg.Env)
            {
                psi.EnvironmentVariables[kv.Key] = kv.Value;
            }

            var proc = new Process { StartInfo = psi };
            proc.Start();

            // Apply OS-level Job Object containment
            JobObjectNative.ApplyProcessContainment(proc);

            StartLogStream(cfg.Name, "out", proc.StandardOutput);
            StartLogStream(cfg.Name, "err", proc.StandardError);

            return new RunningService(cfg, proc);
        }

        private void StartLogStream(string serviceName, string stream, StreamReader reader)
        {
            Task.Run(async () =>
            {
                string logFile = Path.Combine(LogDir, $"{serviceName}.log");
                using var writer = new StreamWriter(logFile, append: true) { AutoFlush = true };

                while (!reader.EndOfStream)
                {
                    string? line = await reader.ReadLineAsync();
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    var entry = new
                    {
                        timestamp = DateTime.UtcNow.ToString("o"),
                        service = serviceName,
                        stream = stream,
                        data = line
                    };

                    string json = JsonSerializer.Serialize(entry);
                    Console.WriteLine($"[{serviceName}:{stream}] {line}");
                    await writer.WriteLineAsync(json);
                }
            });
        }

        public void StopServices()
        {
            lock (_lock)
            {
                // Stop in exact reverse sequence
                for (int i = _services.Count - 1; i >= 0; i--)
                {
                    var svc = _services[i];
                    try
                    {
                        if (!svc.Process.HasExited)
                        {
                            Console.WriteLine($"[SERVICE] Stopping service: {svc.Config.Name}");
                            svc.Process.Kill(entireProcessTree: true);
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[ERROR] Error terminating service {svc.Config.Name}: {ex.Message}");
                    }
                }
                _services.Clear();
            }
        }
    }
}
