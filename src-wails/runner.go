package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// ServiceConfig defines a supervised background service.
type ServiceConfig struct {
	Name          string            `json:"name"`
	Executable    string            `json:"executable"`
	Args          []string          `json:"args"`
	Cwd           string            `json:"cwd"`
	Env           map[string]string `json:"env"`
	ReadinessPort int               `json:"readinessPort"`
	Critical      bool              `json:"critical"`
	TimeoutSec    int               `json:"timeoutSec"`
}

// RunningService tracks an active process instance.
type RunningService struct {
	Config ServiceConfig
	Cmd    *exec.Cmd
}

// ServiceManager handles lifecycle and supervision of background services.
type ServiceManager struct {
	RuntimePath string
	DataDir     string
	LogDir      string
	mu          sync.Mutex
	services    []*RunningService
}

// NewServiceManager initializes the manager given runtime and user data paths.
func NewServiceManager(runtimePath, dataDir, logDir string) *ServiceManager {
	return &ServiceManager{
		RuntimePath: runtimePath,
		DataDir:     dataDir,
		LogDir:      logDir,
		services:    make([]*RunningService, 0),
	}
}

// ResolveRuntimePath locates the local or packaged runtime directory.
func ResolveRuntimePath() string {
	execPath, err := os.Executable()
	if err != nil {
		execPath = "."
	}
	execDir := filepath.Dir(execPath)

	prodPath := filepath.Join(execDir, "resources", "runtime")
	if _, err := os.Stat(prodPath); err == nil {
		return prodPath;
	}

	return filepath.Join(".", "resources", "runtime")
}

// CheckMissingFiles verifies presence of essential runtime components.
func CheckMissingFiles(runtimePath string) []string {
	var missing []string

	requiredFiles := []string{
		filepath.Join(runtimePath, "surreal", "surreal.exe"),
		filepath.Join(runtimePath, "backend", "open_notebook"),
		filepath.Join(runtimePath, "frontend", "server.js"),
		filepath.Join(runtimePath, "manifest.json"),
	}

	for _, req := range requiredFiles {
		if _, err := os.Stat(req); os.IsNotExist(err) {
			missing = append(missing, req)
		}
	}

	return missing
}

// IsPortOpen checks whether a TCP port is responding on localhost.
func IsPortOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 1*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// WaitForPort polls a TCP port until active or timeout reached.
func WaitForPort(port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if IsPortOpen(port) {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for port %d", port)
}

// StartServices launches all services in host-contract mandated sequence.
func (sm *ServiceManager) StartServices() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	backendPath := filepath.Join(sm.RuntimePath, "backend")
	surrealDbFile := filepath.Join(sm.DataDir, "surrealdb", "mydatabase.db")
	_ = os.MkdirAll(filepath.Dir(surrealDbFile), 0755)
	_ = os.MkdirAll(sm.LogDir, 0755)

	// Resolve the per-install database credentials and the provider-API-key
	// encryption key. The credentials travel through the child environment
	// rather than the command line so they never appear in a process listing.
	credentials, err := ResolveDatabaseCredentials(sm.DataDir)
	if err != nil {
		return err
	}
	credentialEnv, err := BuildCredentialEnvironment(credentials)
	if err != nil {
		return err
	}
	encryptionKey, err := EnsureEncryptionKey(sm.DataDir)
	if err != nil {
		return err
	}

	backendEnv := map[string]string{
		"OPEN_NOTEBOOK_ENCRYPTION_KEY": encryptionKey,
		"SURREAL_URL":                  "ws://127.0.0.1:8000/rpc",
		"SURREAL_NAMESPACE":            "open_notebook",
		"SURREAL_DATABASE":             "open_notebook",
	}
	for _, pair := range credentialEnv.AsPairs() {
		backendEnv[pair[0]] = pair[1]
	}

	configs := []ServiceConfig{
		{
			Name:          "surrealdb",
			Executable:    filepath.Join(sm.RuntimePath, "surreal", "surreal.exe"),
			Args:          []string{"start", "--log", "info", "--bind", "127.0.0.1:8000", fmt.Sprintf("rocksdb:%s", surrealDbFile)},
			Cwd:           sm.RuntimePath,
			Env:           backendEnv,
			ReadinessPort: 8000,
			Critical:      true,
			TimeoutSec:    60,
		},
		{
			Name:          "api",
			Executable:    filepath.Join(sm.RuntimePath, "python", "python.exe"),
			Args:          []string{"-m", "uvicorn", "api.main:app", "--host", "127.0.0.1", "--port", "5055"},
			Cwd:           backendPath,
			Env:           backendEnv,
			ReadinessPort: 5055,
			Critical:      true,
			TimeoutSec:    120,
		},
		{
			Name:          "worker",
			Executable:    filepath.Join(sm.RuntimePath, "python", "python.exe"),
			Args:          []string{"-m", "surreal_commands.cli.worker", "--import-modules", "commands", "--max-tasks", "2"},
			Cwd:           backendPath,
			Env:           backendEnv,
			ReadinessPort: 0, // Process liveness
			Critical:      true,
			TimeoutSec:    30,
		},
		{
			Name:          "frontend",
			Executable:    filepath.Join(sm.RuntimePath, "node", "node.exe"),
			Args:          []string{"server.js"},
			Cwd:           filepath.Join(sm.RuntimePath, "frontend"),
			Env:           map[string]string{"PORT": "8502", "HOSTNAME": "127.0.0.1", "INTERNAL_API_URL": "http://127.0.0.1:5055"},
			ReadinessPort: 8502,
			Critical:      true,
			TimeoutSec:    120,
		},
	}

	for _, cfg := range configs {
		svc, err := sm.spawnService(cfg)
		if err != nil {
			return fmt.Errorf("failed spawning service %s: %w", cfg.Name, err)
		}
		sm.services = append(sm.services, svc)

		if cfg.ReadinessPort > 0 {
			if err := WaitForPort(cfg.ReadinessPort, time.Duration(cfg.TimeoutSec)*time.Second); err != nil {
				return fmt.Errorf("readiness check failed for %s on port %d: %w", cfg.Name, cfg.ReadinessPort, err)
			}
		}
	}

	return nil
}

func (sm *ServiceManager) spawnService(cfg ServiceConfig) (*RunningService, error) {
	cmd := exec.Command(cfg.Executable, cfg.Args...)
	cmd.Dir = cfg.Cwd

	if len(cfg.Env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range cfg.Env {
			cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
		}
	}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	// Apply OS process group containment before start
	ApplyProcessContainmentPreStart(cmd)

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Attach to OS Job Object after start
	ApplyProcessContainmentPostStart(cmd)

	// Stream tagging for standard output and standard error
	go streamLogs(cfg.Name, "out", stdoutPipe, sm.LogDir)
	go streamLogs(cfg.Name, "err", stderrPipe, sm.LogDir)

	return &RunningService{
		Config: cfg,
		Cmd:    cmd,
	}, nil
}

func streamLogs(serviceName, stream string, pipe io.Reader, logDir string) {
	scanner := bufio.NewScanner(pipe)
	logPath := filepath.Join(logDir, fmt.Sprintf("%s.log", serviceName))
	f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	defer func() {
		if f != nil {
			f.Close()
		}
	}()

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		entry := map[string]string{
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"service":   serviceName,
			"stream":    stream,
			"data":      line,
		}
		jsonData, _ := json.Marshal(entry)
		fmt.Printf("[%s:%s] %s\n", serviceName, stream, line)

		if f != nil {
			f.Write(append(jsonData, '\n'))
		}
	}
}

// StopServices shuts down running services in exact reverse order of startup.
func (sm *ServiceManager) StopServices() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for i := len(sm.services) - 1; i >= 0; i-- {
		svc := sm.services[i]
		if svc.Cmd != nil && svc.Cmd.Process != nil {
			fmt.Printf("Stopping service: %s\n", svc.Config.Name)
			_ = svc.Cmd.Process.Kill()
		}
	}
	sm.services = make([]*RunningService, 0)
}
