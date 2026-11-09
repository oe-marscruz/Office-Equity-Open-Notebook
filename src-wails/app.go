package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// App struct holds application state and Wails bindings.
type App struct {
	ctx          context.Context
	serviceMgr   *ServiceManager
	navPolicy    *NavigationPolicy
	proxyServer  *ProxyServer
	runtimePath  string
	dataDir      string
	logDir       string
}

// NewApp creates a new App application struct.
func NewApp(enableProxy bool) *App {
	runtimePath := ResolveRuntimePath()

	homeDir, err := os.UserHomeDir()
	if err != nil {
		homeDir = "."
	}
	dataDir := filepath.Join(homeDir, "OfficeEquityOpenNotebook")
	logDir := filepath.Join(dataDir, "logs")

	return &App{
		serviceMgr:  NewServiceManager(runtimePath, dataDir, logDir),
		navPolicy:   NewNavigationPolicy("http://127.0.0.1:8502"),
		proxyServer: NewProxyServer(enableProxy, "127.0.0.1:8503", "http://127.0.0.1:5055", filepath.Join(runtimePath, "frontend")),
		runtimePath: runtimePath,
		dataDir:     dataDir,
		logDir:      logDir,
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// 1. Verify runtime components
	missing := CheckMissingFiles(a.runtimePath)
	if len(missing) > 0 {
		fmt.Printf("Office Equity Open Notebook — missing runtime files: %v\n", missing)
	}

	// 2. Start services
	if err := a.serviceMgr.StartServices(); err != nil {
		fmt.Printf("CRITICAL: Failed to start background services: %v\n", err)
	}

	// 3. Start proxy server if enabled
	if err := a.proxyServer.Start(); err != nil {
		fmt.Printf("Warning: Proxy server failed to start: %v\n", err)
	}
}

// shutdown is called when Wails shuts down.
func (a *App) shutdown(ctx context.Context) {
	if a.proxyServer != nil {
		_ = a.proxyServer.Stop()
	}
	if a.serviceMgr != nil {
		a.serviceMgr.StopServices()
	}
}

// GetStatus returns runtime status overview.
func (a *App) GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"runtimePath": a.runtimePath,
		"dataDir":     a.dataDir,
		"logDir":      a.logDir,
		"status":      "running",
	}
}
