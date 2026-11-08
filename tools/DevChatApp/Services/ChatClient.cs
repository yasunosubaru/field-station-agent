using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using DevChatApp.Models;

namespace DevChatApp.Services;

public sealed class ChatException : Exception
{
    public ChatException(string message) : base(message) { }
}

/// <summary>
/// 与 tools/dev_chat.py 的 HTTP 接口通信。
/// 接口契约见 docs/operations/dev-chat.md。
/// </summary>
public sealed class ChatClient : IDisposable
{
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public string BaseUrl { get; private set; }
    public string Token { get; private set; }

    public ChatClient(string baseUrl, string token)
    {
        BaseUrl = baseUrl.TrimEnd('/');
        Token = token ?? "";
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        if (!string.IsNullOrEmpty(Token))
        {
            _http.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", Token);
        }
    }

    public void Reconfigure(string baseUrl, string token)
    {
        BaseUrl = baseUrl.TrimEnd('/');
        Token = token ?? "";
        _http.DefaultRequestHeaders.Authorization =
            string.IsNullOrEmpty(Token)
                ? null
                : new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", Token);
    }

    private sealed class MessagesResponse
    {
        [JsonPropertyName("total")] public long Total { get; set; }
        [JsonPropertyName("messages")] public List<ChatMessage> Messages { get; set; } = new();
    }

    private sealed class SayRequest
    {
        [JsonPropertyName("who")] public string Who { get; set; } = "";
        [JsonPropertyName("text")] public string Text { get; set; } = "";
        [JsonPropertyName("tag")] public string Tag { get; set; } = "";
    }

    private sealed class SayResponse
    {
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("row")] public ChatMessage? Row { get; set; }
        [JsonPropertyName("total")] public long Total { get; set; }
    }

    private sealed class ErrorResponse
    {
        [JsonPropertyName("error")] public string Error { get; set; } = "";
    }

    public async Task<(long total, List<ChatMessage> messages)> GetMessagesAsync(
        long since, CancellationToken ct = default)
    {
        try
        {
            var url = $"{BaseUrl}/api/messages?since={since}";
            using var resp = await _http.GetAsync(url, ct).ConfigureAwait(false);
            if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                throw new ChatException("服务要求 token，请在设置里填写");
            resp.EnsureSuccessStatusCode();
            var d = await resp.Content.ReadFromJsonAsync<MessagesResponse>(JsonOpts, ct)
                        .ConfigureAwait(false);
            return d is null ? (0, new List<ChatMessage>()) : (d.Total, d.Messages);
        }
        catch (ChatException) { throw; }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ChatException("连接超时（服务可能在忙）");
        }
        catch (HttpRequestException e)
        {
            throw new ChatException("连不上服务：" + e.Message);
        }
    }

    public async Task<ChatMessage> SayAsync(string who, string text, string tag = "",
                                            CancellationToken ct = default)
    {
        try
        {
            var body = new SayRequest { Who = who, Text = text, Tag = tag };
            using var resp = await _http.PostAsJsonAsync($"{BaseUrl}/api/say", body, JsonOpts, ct)
                                        .ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                string detail = "";
                try
                {
                    var e = await resp.Content.ReadFromJsonAsync<ErrorResponse>(JsonOpts, ct)
                                           .ConfigureAwait(false);
                    detail = e?.Error ?? "";
                }
                catch { /* 忽略解析失败 */ }
                throw new ChatException(
                    resp.StatusCode == System.Net.HttpStatusCode.Unauthorized
                        ? "token 不对或无权限"
                        : $"服务端拒绝（{(int)resp.StatusCode}）：{detail}");
            }
            var d = await resp.Content.ReadFromJsonAsync<SayResponse>(JsonOpts, ct)
                                   .ConfigureAwait(false);
            if (d?.Row is null) throw new ChatException("服务返回了空消息");
            return d.Row;
        }
        catch (ChatException) { throw; }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ChatException("发送超时");
        }
        catch (HttpRequestException e)
        {
            throw new ChatException("连不上服务：" + e.Message);
        }
    }

    public async Task<bool> PingAsync(CancellationToken ct = default)
    {
        try
        {
            using var resp = await _http.GetAsync($"{BaseUrl}/api/health", ct).ConfigureAwait(false);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose() => _http.Dispose();
}
