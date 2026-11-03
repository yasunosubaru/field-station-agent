using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NasGui;

/// <summary>
/// One-window shell around the All powered-FSA suite. The payload (Node runtime + the TS
/// implementation + the sample tree + the shipped view assets) is embedded as a zip; on first run
/// it is extracted under %LOCALAPPDATA%\AllPoweredFSA, the app's own HTTP server is started on
/// 127.0.0.1:0, and WebView2 points at it. Closing the window kills the server.
/// </summary>
public sealed class MainForm : Form
{
    /* Kept as NasGui.payload.zip on purpose: RootNamespace is still NasGui and the csproj pins
     * this logical name, so renaming the assembly cannot silently break payload lookup. */
    private const string PayloadResource = "NasGui.payload.zip";
    private const string AppName = "AllPoweredFSA";
    private const string AppTitle = "All powered-FSA";
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly Label _status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font("Segoe UI", 11f),
        Text = "Preparing All powered-FSA… / 正在准备 All powered-FSA…",
    };
    private Process? _server;
    private string _root = "";

    public MainForm()
    {
        Text = AppTitle;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        /* Sizes are device pixels under PerMonitorV2, so ask the screen for its scale: a 1440x900
         * *logical* window on a 150 % display is 2160x1350, which does not fit 1707x1067 — that is
         * exactly the case where the old build opened a window whose right third was off-screen. */
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        float scale;
        using (var screen = Graphics.FromHwnd(IntPtr.Zero)) scale = screen.DpiX / 96f;
        Width = (int)Math.Min(1440 * scale, area.Width);
        Height = (int)Math.Min(900 * scale, area.Height);
        MinimumSize = new Size((int)Math.Min(1000 * scale, area.Width), (int)Math.Min(700 * scale, area.Height));
        StartPosition = FormStartPosition.CenterScreen;
        if (Width >= area.Width || Height >= area.Height) WindowState = FormWindowState.Maximized;
        Controls.Add(_web);
        Controls.Add(_status);
        Shown += async (_, _) => await StartAsync();
        FormClosing += (_, _) => StopServer();
    }

    private async Task StartAsync()
    {
        try
        {
            _root = await Task.Run(ExtractPayload);
            Status("Starting the local server… / 正在启动本地服务…");
            var port = await Task.Run(StartServer);
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                AppName, "webview2");
            /* NAS_DEBUG_PORT is a maintenance door, not a feature: it lets the pack be inspected
             * from outside (DOM, console, screenshots) without a second build. */
            var debugPort = Environment.GetEnvironmentVariable("NAS_DEBUG_PORT");
            var options = new CoreWebView2EnvironmentOptions();
            if (int.TryParse(debugPort, out var devtoolsPort) && devtoolsPort > 0)
            {
                options.AdditionalBrowserArguments = $"--remote-debugging-port={devtoolsPort}";
            }
            var env = await CoreWebView2Environment.CreateAsync(null, userData, options);
            await _web.EnsureCoreWebView2Async(env);
            _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _status.Visible = false;
            _web.Visible = true;
            _web.CoreWebView2.Navigate($"http://127.0.0.1:{port}/");
        }
        catch (Exception error)
        {
            Status($"Could not start {AppTitle}: {error.Message}\n" +
                   $"{AppTitle} 启动失败：{error.Message}");
        }
    }

    private void Status(string text)
    {
        _status.Text = text;
        _status.Visible = true;
        _status.BringToFront();
    }

    private static string ExtractPayload()
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.2.0";
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            AppName, $"app-{version}");
        var marker = Path.Combine(root, ".ready");
        if (File.Exists(marker)) { CleanOldVersions(root); return root; }

        if (Directory.Exists(root)) Directory.Delete(root, true);
        Directory.CreateDirectory(root);
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource)
            ?? throw new InvalidOperationException("payload.zip is missing from this build");
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        archive.ExtractToDirectory(root, overwriteFiles: true);
        File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
        CleanOldVersions(root);
        return root;
    }

    /// <summary>
    /// One extracted tree per version is enough. The payload leaves a few hundred MB behind per
    /// update; the previous version is never read again, so it goes (a failure to delete is not
    /// fatal).
    /// </summary>
    private static void CleanOldVersions(string root)
    {
        var parent = Path.GetDirectoryName(root);
        if (parent is null) return;
        foreach (var dir in Directory.GetDirectories(parent, "app-*"))
        {
            if (string.Equals(Path.GetFullPath(dir), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) continue;
            try { Directory.Delete(dir, true); } catch { /* locked by an older instance still running */ }
        }
    }

    private int StartServer()
    {
        var impl = Path.Combine(_root, "逆向", "04_重实现");
        var node = Path.Combine(_root, "runtime", "node.exe");
        if (!File.Exists(node)) throw new FileNotFoundException("the bundled Node runtime is missing", node);

        var start = new ProcessStartInfo(node, "packages/app/src/server.ts --port 0")
        {
            WorkingDirectory = impl,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // The Workflows tab shells out to the Python executor. Point it at the bundled runtime when
        // the payload carries one; otherwise the bridge reports "workflow unavailable" and the rest
        // of the app keeps working.
        var python = Path.Combine(_root, "runtime", "python", "python.exe");
        if (File.Exists(python)) start.EnvironmentVariables["NAS_PYTHON"] = python;
        // FSA_ROOT is the extracted payload root; the Python side resolves src/, tools/, config/
        // and workflows/ from it. FSA_SUITE_DIR only exists when the payload was built with
        // --with-original, and then points at the installed suite tree.
        start.EnvironmentVariables["FSA_ROOT"] = _root;
        var suite = Path.Combine(_root, "original");
        if (!Directory.Exists(suite)) suite = Path.Combine(_root, "payload", "original");
        if (Directory.Exists(suite)) start.EnvironmentVariables["FSA_SUITE_DIR"] = suite;
        // Job receipts must survive a version upgrade (the extractor deletes older app-* trees).
        var jobs = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            AppName, "jobs");
        Directory.CreateDirectory(jobs);
        start.EnvironmentVariables["NAS_WORKFLOW_JOBS"] = jobs;
        _server = new Process { StartInfo = start };
        var ready = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        _server.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            var match = System.Text.RegularExpressions.Regex.Match(e.Data, @"READY (\d+)");
            if (match.Success) ready.TrySetResult(int.Parse(match.Groups[1].Value));
        };
        _server.ErrorDataReceived += (_, _) => { };
        _server.Start();
        _server.BeginOutputReadLine();
        _server.BeginErrorReadLine();
        if (!ready.Task.Wait(TimeSpan.FromSeconds(40)))
        {
            StopServer();
            throw new TimeoutException("the local server did not report READY within 40 s");
        }
        return ready.Task.Result;
    }

    private void StopServer()
    {
        try
        {
            if (_server is { HasExited: false }) _server.Kill(entireProcessTree: true);
        }
        catch
        {
            // closing the window must not throw
        }
        _server?.Dispose();
        _server = null;
    }
}
