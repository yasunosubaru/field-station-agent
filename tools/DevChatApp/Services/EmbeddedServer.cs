using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace DevChatApp.Services;

/// <summary>
/// 可选：由本应用自己去起 tools/dev_chat.py。
///
/// 为什么需要：用户双击 exe 时不该先开一个终端跑 Python。
/// 本类找到解释器和脚本、拉起来、等 DEV_CHAT_READY 那行拿端口，退出时杀进程树。
///
/// 找不到解释器时不算致命：应用仍可连一个已在跑的远端服务。
/// </summary>
public sealed class EmbeddedServer : IDisposable
{
    private Process? _proc;
    private readonly StringBuilder _log = new();

    public string? BaseUrl { get; private set; }
    public string? Token { get; private set; }
    public bool IsRunning => _proc is { HasExited: false };
    public string Log => _log.ToString();

    /// <summary>从 exe 位置往上找仓库根（含 tools/dev_chat.py 的那一层）。</summary>
    public static string? FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "tools", "dev_chat.py")))
                return dir.FullName;
        }
        return null;
    }

    /// <summary>在仓库根附近找 Python 解释器：优先 .deps/venv，其次 PATH。</summary>
    public static string? FindPython(string repoRoot)
    {
        var candidates = new[]
        {
            Path.Combine(repoRoot, ".deps", "venv", "Scripts", "python.exe"),
            Path.Combine(repoRoot, ".venv", "Scripts", "python.exe"),
            Path.Combine(repoRoot, "venv", "Scripts", "python.exe"),
        };
        foreach (var c in candidates)
        {
            if (File.Exists(c)) return c;
        }

        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var p in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var exe = Path.Combine(p.Trim(), "python.exe");
                if (File.Exists(exe)) return exe;
            }
            catch { /* 非法路径跳过 */ }
        }
        return null;
    }

    /// <summary>
    /// 起服务并等就绪。成功返回 true，BaseUrl/Token 已填好。
    /// 失败时 <paramref name="reason"/> 说明原因。
    /// </summary>
    public async Task<bool> StartAsync(string? explicitRepoRoot, string? explicitPython,
                                      string logPath, CancellationToken ct = default)
    {
        var repo = explicitRepoRoot;
        if (string.IsNullOrWhiteSpace(repo) || !Directory.Exists(repo))
            repo = FindRepoRoot();
        if (repo is null)
        {
            _log.AppendLine("找不到仓库根（往上 8 层都没有 tools/dev_chat.py）");
            return false;
        }

        var script = Path.Combine(repo, "tools", "dev_chat.py");
        if (!File.Exists(script))
        {
            _log.AppendLine("找不到脚本：" + script);
            return false;
        }

        var py = explicitPython;
        if (string.IsNullOrWhiteSpace(py) || !File.Exists(py))
            py = FindPython(repo);
        if (py is null)
        {
            _log.AppendLine("找不到 python.exe（.deps/venv 和 PATH 里都没有）");
            return false;
        }

        Token = Guid.NewGuid().ToString("N");

        var psi = new ProcessStartInfo
        {
            FileName = py,
            WorkingDirectory = repo,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(script);
        psi.ArgumentList.Add("--host");
        psi.ArgumentList.Add("127.0.0.1");   // 内置模式默认只本机
        psi.ArgumentList.Add("--port");
        psi.ArgumentList.Add("0");
        psi.ArgumentList.Add("--token");
        psi.ArgumentList.Add(Token);
        psi.ArgumentList.Add("--log");
        psi.ArgumentList.Add(logPath);

        try
        {
            _proc = Process.Start(psi);
        }
        catch (Exception e)
        {
            _log.AppendLine("启动失败：" + e.Message);
            return false;
        }
        if (_proc is null)
        {
            _log.AppendLine("启动失败：Process.Start 返回 null");
            return false;
        }

        // 等 DEV_CHAT_READY <port>
        var ready = new TaskCompletionSource<int?>();
        _proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            _log.AppendLine(e.Data);
            var line = e.Data.Trim();
            if (line.StartsWith("DEV_CHAT_READY ", StringComparison.Ordinal))
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 2 && int.TryParse(parts[1], out var port))
                    ready.TrySetResult(port);
            }
        };
        _proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is not null) _log.AppendLine("[err] " + e.Data);
        };
        _proc.BeginOutputReadLine();
        _proc.BeginErrorReadLine();

        var done = await Task.WhenAny(ready.Task, Task.Delay(TimeSpan.FromSeconds(20), ct))
                             .ConfigureAwait(false);
        if (done != ready.Task || ready.Task.Result is null)
        {
            _log.AppendLine("20 秒内没等到 DEV_CHAT_READY");
            Kill();
            return false;
        }

        BaseUrl = $"http://127.0.0.1:{ready.Task.Result.Value}";
        return true;
    }

    /// <summary>杀进程树。Windows 上必须杀整棵树，否则孤儿占端口。</summary>
    public void Kill()
    {
        var p = _proc;
        _proc = null;
        if (p is null) return;
        try
        {
            if (!p.HasExited)
            {
                // /T 杀整棵树，/F 强制
                var k = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    ArgumentList = { "/PID", p.Id.ToString(), "/T", "/F" },
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                k?.WaitForExit(5000);
            }
        }
        catch { /* 进程可能已退出 */ }
        finally
        {
            try { p.Dispose(); } catch { }
        }
    }

    public void Dispose() => Kill();
}
