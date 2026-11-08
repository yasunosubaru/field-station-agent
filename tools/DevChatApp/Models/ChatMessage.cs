using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace DevChatApp.Models;

/// <summary>一条聊天消息。字段名与 tools/dev_chat.py 的 JSONL 一致。</summary>
public sealed class ChatMessage
{
    [JsonPropertyName("seq")] public long Seq { get; set; }
    [JsonPropertyName("who")] public string Who { get; set; } = "";
    [JsonPropertyName("text")] public string Text { get; set; } = "";
    [JsonPropertyName("tag")] public string Tag { get; set; } = "";
    [JsonPropertyName("at")] public string At { get; set; } = "";

    /// <summary>给界面用：HH:mm 形式。</summary>
    [JsonIgnore]
    public string ShortTime
    {
        get
        {
            var s = At;
            int i = s.IndexOf('T');
            if (i >= 0 && s.Length >= i + 6) return s.Substring(i + 1, 5);
            return s.Length >= 5 ? s.Substring(s.Length - 5) : s;
        }
    }

    [JsonIgnore] public bool HasTag => !string.IsNullOrEmpty(Tag);
}

/// <summary>五名成员。顺序决定侧栏顺序。</summary>
public sealed class Member
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Role { get; init; } = "";
    public string ColorHex { get; init; } = "#94908A";
}

public static class Members
{
    public static readonly IReadOnlyList<Member> All = new[]
    {
        new Member { Id = "A",  Name = "A 线", Role = "后台记账", ColorHex = "#3A6EA5" },
        new Member { Id = "B",  Name = "B 线", Role = "AI 工具",  ColorHex = "#4A8A3F" },
        new Member { Id = "C",  Name = "C 线", Role = "界面",     ColorHex = "#9A5AA8" },
        new Member { Id = "D",  Name = "D 线", Role = "数据设备", ColorHex = "#B8791A" },
        new Member { Id = "你", Name = "你",   Role = "决策",     ColorHex = "#C2603A" },
    };

    public static string ColorOf(string who)
    {
        foreach (var m in All)
        {
            if (m.Id == who) return m.ColorHex;
        }
        return "#94908A";
    }

    public static string NameOf(string who)
    {
        foreach (var m in All)
        {
            if (m.Id == who) return m.Name;
        }
        return who;
    }

    /// <summary>把 USER / user / u / 小写字母归一成成员 id；不认得返回 null。</summary>
    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var w = raw.Trim();
        if (w == "你") return "你";
        var up = w.ToUpperInvariant();
        if (up is "A" or "B" or "C" or "D") return up;
        if (up is "USER" or "U") return "你";
        return null;
    }
}
