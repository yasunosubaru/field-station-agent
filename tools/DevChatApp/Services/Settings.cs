using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace DevChatApp.Services;

/// <summary>本地设置。存在 %LOCALAPPDATA%\DevChat\settings.json。</summary>
public sealed class Settings
{
    public string BaseUrl { get; set; } = "http://127.0.0.1:7805";
    public string Token { get; set; } = "";
    public string Identity { get; set; } = "你";
    public string RepoRoot { get; set; } = "";
    public string PythonPath { get; set; } = "";

    // ---- 默认值兜底 ----

    /// <summary>
    /// 用 exe 同目录的 devchat.json、环境变量、自动探测三条来源补齐空字段。
    /// 调用一次即可（在 Load 之后）。
    /// </summary>
    public void FillLocator()
    {
        var (repo, py) = ReadLocator();

        if (string.IsNullOrWhiteSpace(RepoRoot))
        {
            var env = Environment.GetEnvironmentVariable("DEVCHAT_REPO");
            if (!string.IsNullOrWhiteSpace(env)) RepoRoot = env;
            else if (!string.IsNullOrWhiteSpace(repo)) RepoRoot = repo!;
            else RepoRoot = EmbeddedServer.FindRepoRoot() ?? "";
        }

        if (string.IsNullOrWhiteSpace(PythonPath))
        {
            var env = Environment.GetEnvironmentVariable("DEVCHAT_PYTHON");
            if (!string.IsNullOrWhiteSpace(env)) PythonPath = env;
            else if (!string.IsNullOrWhiteSpace(py)) PythonPath = py!;
        }
    }

    /// <summary>true = 应用自己起 Python 服务；false = 连已有服务。</summary>
    public bool EmbeddedMode { get; set; } = true;

    /// <summary>窗口尺寸，下次打开恢复。</summary>
    public double WindowWidth { get; set; } = 1100;
    public double WindowHeight { get; set; } = 760;

    /// <summary>
    /// 读 exe 同目录的 devchat.json（发布版用）。
    /// 返回 (repoRoot, python)，缺的字段为 null。
    ///
    /// ⚠ 关键：自包含单文件（PublishSingleFile）运行时，
    /// `AppContext.BaseDirectory` 指向 **临时解压目录**
    /// （%TEMP%\.net\DevChat\&lt;hash&gt;\），不是 exe 所在目录。
    /// 所以必须用 `Environment.ProcessPath` 反推 exe 目录，
    /// 否则永远读不到 exe 旁边那份配置。
    /// </summary>
    public static (string? repoRoot, string? python) ReadLocator()
    {
        foreach (var dir in CandidateDirs())
        {
            try
            {
                var p = Path.Combine(dir, "devchat.json");
                if (!File.Exists(p)) continue;
                using var doc = JsonDocument.Parse(File.ReadAllText(p));
                var root = doc.RootElement;
                string? repo = root.TryGetProperty("repoRoot", out var r) ? r.GetString() : null;
                string? py = root.TryGetProperty("python", out var y) ? y.GetString() : null;
                if (!string.IsNullOrWhiteSpace(repo) || !string.IsNullOrWhiteSpace(py))
                    return (repo, py);
            }
            catch { /* 换下一个候选 */ }
        }
        return (null, null);
    }

    /// <summary>找 devchat.json 的候选目录：先 exe 实际所在，再运行时目录。</summary>
    private static IEnumerable<string> CandidateDirs()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // ① exe 真实路径（单文件发布时这才是发布目录）
        string? exeDir = null;
        try
        {
            var proc = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(proc))
                exeDir = Path.GetDirectoryName(proc);
        }
        catch { }
        if (!string.IsNullOrWhiteSpace(exeDir) && seen.Add(exeDir!))
            yield return exeDir!;

        // ② AppContext.BaseDirectory（非单文件、或开发态）
        var baseDir = AppContext.BaseDirectory;
        if (!string.IsNullOrWhiteSpace(baseDir) && seen.Add(baseDir))
            yield return baseDir;

        // ③ 从 exe 往上几层（开发态 bin\Release\...\win-x64）
        if (!string.IsNullOrWhiteSpace(exeDir))
        {
            var d = new DirectoryInfo(exeDir!);
            for (int i = 0; i < 6 && d?.Parent is not null; i++)
            {
                d = d.Parent;
                if (seen.Add(d!.FullName))
                    yield return d.FullName;
            }
        }
    }

    // ---- 存档 ----

    private static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                     "DevChat");

    private static string FilePath => Path.Combine(Dir, "settings.json");

    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = true };

    public static Settings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var json = File.ReadAllText(FilePath);
                var s = JsonSerializer.Deserialize<Settings>(json, Opts);
                if (s is not null) return s;
            }
        }
        catch { /* 坏了就用默认值，不阻塞启动 */ }
        return new Settings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Opts));
        }
        catch { /* 写不进去也不该崩 */ }
    }
}
