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

    /// <summary>true = 应用自己起 Python 服务；false = 连已有服务。</summary>
    public bool EmbeddedMode { get; set; } = true;

    /// <summary>窗口尺寸，下次打开恢复。</summary>
    public double WindowWidth { get; set; } = 1100;
    public double WindowHeight { get; set; } = 760;

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
