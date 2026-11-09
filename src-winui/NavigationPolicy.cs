using System;
using System.Diagnostics;

namespace OfficeEquityOpenNotebook
{
    public class NavigationPolicy
    {
        public string AllowedOrigin { get; }

        public NavigationPolicy(string? allowedOrigin = null)
        {
            AllowedOrigin = string.IsNullOrWhiteSpace(allowedOrigin) ? "http://127.0.0.1:8502" : allowedOrigin;
        }

        public bool IsAllowedOrigin(string targetUrl)
        {
            if (string.IsNullOrWhiteSpace(targetUrl)) return false;
            if (targetUrl.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) return false;

            if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out Uri? targetUri)) return false;
            if (!Uri.TryCreate(AllowedOrigin, UriKind.Absolute, out Uri? allowedUri)) return false;

            return string.Equals(targetUri.Scheme, allowedUri.Scheme, StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(targetUri.Host, allowedUri.Host, StringComparison.OrdinalIgnoreCase) &&
                   targetUri.Port == allowedUri.Port;
        }

        /// <summary>
        /// Classifies a navigation target as "allow", "external" or "deny".
        ///
        /// This mirrors the Rust, TypeScript and Go hosts so the shared
        /// compatibility fixture can be replayed verbatim. It is also what
        /// <see cref="HandleNavigation"/> acts on, which keeps the decision the
        /// tests assert and the decision the window makes in one place.
        /// </summary>
        public string NavigationAction(string targetUrl)
        {
            if (IsAllowedOrigin(targetUrl))
            {
                return "allow";
            }
            if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out Uri? targetUri))
            {
                return "deny";
            }
            string scheme = targetUri.Scheme.ToLowerInvariant();
            return scheme is "http" or "https" ? "external" : "deny";
        }

        public bool HandleNavigation(string targetUrl, out bool allowInWebView)
        {
            switch (NavigationAction(targetUrl))
            {
                case "allow":
                    allowInWebView = true;
                    return true;
                case "external":
                    allowInWebView = false;
                    Console.WriteLine($"[SECURITY] Delegated external navigation to the system browser: {targetUrl}");
                    return OpenInSystemBrowser(targetUrl);
                default:
                    allowInWebView = false;
                    Console.WriteLine($"[SECURITY] Prohibited scheme or untrusted origin: {targetUrl}");
                    return false;
            }
        }

        public static bool OpenInSystemBrowser(string targetUrl)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = targetUrl,
                    UseShellExecute = true
                });
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ERROR] Failed to open URL in default browser: {ex.Message}");
                return false;
            }
        }
    }
}
