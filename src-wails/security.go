package main

import (
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
)

// NavigationPolicy manages WebView navigation and external URL handling.
type NavigationPolicy struct {
	AllowedOrigin string
}

// NewNavigationPolicy initializes a policy targeting the local frontend server.
func NewNavigationPolicy(allowedOrigin string) *NavigationPolicy {
	if allowedOrigin == "" {
		allowedOrigin = "http://127.0.0.1:8502"
	}
	return &NavigationPolicy{
		AllowedOrigin: allowedOrigin,
	}
}

// IsAllowedOrigin checks if a URL belongs strictly to the local frontend origin.
func (p *NavigationPolicy) IsAllowedOrigin(targetURL string) bool {
	if strings.HasPrefix(targetURL, "file://") {
		return false
	}

	parsedTarget, err := url.Parse(targetURL)
	if err != nil {
		return false
	}

	parsedAllowed, err := url.Parse(p.AllowedOrigin)
	if err != nil {
		return false
	}

	return parsedTarget.Scheme == parsedAllowed.Scheme &&
		parsedTarget.Host == parsedAllowed.Host
}

// NavigationAction classifies a navigation target the same way the Rust,
// TypeScript and C# hosts do, so the shared compatibility fixture can be
// replayed verbatim.
//
// It is also what HandleNavigation acts on, which keeps the decision the tests
// assert and the decision the window makes in one place.
func (p *NavigationPolicy) NavigationAction(targetURL string) string {
	if p.IsAllowedOrigin(targetURL) {
		return "allow"
	}
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return "deny"
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return "external"
	default:
		return "deny"
	}
}

// HandleNavigation evaluates target URLs and delegates non-origin HTTP/HTTPS links to OS default browser.
func (p *NavigationPolicy) HandleNavigation(targetURL string) (allowInWebView bool, err error) {
	switch p.NavigationAction(targetURL) {
	case "allow":
		return true, nil
	case "external":
		return false, OpenInSystemBrowser(targetURL)
	}
	return false, fmt.Errorf("prohibited scheme or untrusted origin: %s", targetURL)
}

// OpenInSystemBrowser opens a URL in the user's default web browser across OS platforms.
func OpenInSystemBrowser(targetURL string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL)
	case "darwin":
		cmd = exec.Command("open", targetURL)
	default: // linux / freebsd
		cmd = exec.Command("xdg-open", targetURL)
	}
	return cmd.Start()
}
