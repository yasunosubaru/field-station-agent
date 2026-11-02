using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NasGui;

/// <summary>
/// One-window shell around the reverse-engineered suite. The payload (Node runtime + the TS
/// implementation + the sample tree + the shipped view assets) is embedded as a zip; on first run
/// it is extracted under %LOCALAPPDATA%, the app's own HTTP server is started on 127.0.0.1:0, and
/// WebView2 points at it. Closing the window kills the server.
/// </summary>
public sealed class MainForm : Form
{
    private const string PayloadResource = "NasGui.payload.zip";
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly Label _status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font("Segoe UI", 11f),
        Text = "Preparing the suite…",
    };
    private Process? _server;
    private string _root = "";

    public MainForm()
    {
        Text = "NovAtel Application Suite — reverse-engineered";
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Width = 1440;
        Height = 900;
        MinimumSize = new Size(1000, 700);
        StartPosition = FormStartPosition.CenterScreen;
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
            Status("Starting the local server…");
            var port = await Task.Run(StartServer);
            var env = await CoreWebView2Environment.CreateAsync(
                null,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NovAtelReverse", "webview2"));
            await _web.EnsureCoreWebView2Async(env);
            _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _status.Visible = false;
            _web.Visible = true;
            _web.CoreWebView2.Navigate($"http://127.0.0.1:{port}/");
        }
        catch (Exception error)
        {
            Status($"Could not start: {error.Message}");
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
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.1.0";
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NovAtelReverse", $"app-{version}");
        var marker = Path.Combine(root, ".ready");
        if (File.Exists(marker)) return root;

        if (Directory.Exists(root)) Directory.Delete(root, true);
        Directory.CreateDirectory(root);
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource)
            ?? throw new InvalidOperationException("payload.zip is missing from this build");
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        archive.ExtractToDirectory(root, overwriteFiles: true);
        File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
        return root;
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
