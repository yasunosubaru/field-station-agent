using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using DevChatApp.Models;
using DevChatApp.Services;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.System;
using Windows.UI;

using Path = System.IO.Path;
using Ellipse = Microsoft.UI.Xaml.Shapes.Ellipse;

namespace DevChatApp;

public sealed partial class MainWindow : Window
{
    private readonly Settings _settings;
    private ChatClient? _client;
    private readonly EmbeddedServer _embedded = new();
    private readonly ObservableCollection<ChatMessage> _all = new();
    private long _lastSeq;
    private string? _filter;
    private DispatcherTimer? _timer;
    private bool _busy;
    private bool _autoScroll = true;
    private bool _started;

    private readonly Dictionary<string, (Border pill, TextBlock count, Border row)> _nav = new();
    private readonly Dictionary<string, TextBlock> _navLabel = new();

    public MainWindow()
    {
        InitializeComponent();

        _settings = Settings.Load();
        Title = "开发群聊";

        // 主题资源挂在窗口根元素上，先接上再建任何带颜色的控件
        Theme.Attach(RootGrid());

        BuildMembers();
        BuildNav();
        Render();

        WhoBox.Items.Clear();
        foreach (var m in Members.All)
            WhoBox.Items.Add(new ComboBoxItem
            {
                Content = $"{m.Name}（{m.Role}）",
                Tag = m.Id
            });
        SelectIdentity(_settings.Identity);

        FeedScroll.ViewChanged += OnFeedScrolled;
        Activated += OnActivated;
        Closed += OnClosed;
    }

    // ================= 启动 =================

    private async void OnActivated(object sender, WindowActivatedEventArgs args)
    {
        if (_started) return;
        _started = true;

        try
        {
            Theme.ApplyTitleBar(this, dark: true);
            Theme.ResizeClient(this, _settings.WindowWidth, _settings.WindowHeight);
        }
        catch { /* 尺寸调整失败不影响使用 */ }

        if (_settings.EmbeddedMode)
        {
            await StartEmbeddedAsync();
        }
        else
        {
            _client = new ChatClient(_settings.BaseUrl, _settings.Token);
        }

        StartPolling();
        await RefreshAsync();
    }

    private async Task StartEmbeddedAsync()
    {
        SetStatus("正在启动本地服务…", ok: true);

        // 关键：用仓库里的 logs/dev_chat/chat.jsonl，
        // 这样内置服务与「另一处起着的 dev_chat.py」看到同一份历史，
        // 不会出现「为什么这里 0 条」。
        string logPath;
        var repo = EmbeddedServer.FindRepoRoot();
        if (!string.IsNullOrWhiteSpace(_settings.RepoRoot) && Directory.Exists(_settings.RepoRoot))
            repo = _settings.RepoRoot;

        if (repo is not null && Directory.Exists(repo))
        {
            logPath = Path.Combine(repo, "logs", "dev_chat", "chat.jsonl");
        }
        else
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DevChat");
            Directory.CreateDirectory(dir);
            logPath = Path.Combine(dir, "chat.jsonl");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

        var ok = await _embedded.StartAsync(_settings.RepoRoot, _settings.PythonPath, logPath);
        if (ok && _embedded.BaseUrl is { } url)
        {
            _settings.BaseUrl = url;
            _settings.Token = _embedded.Token ?? "";
            _client = new ChatClient(url, _settings.Token);
            SetStatus("本地服务已就绪", ok: true);
            return;
        }

        // 内置失败 → 退回连已有服务，并告诉用户
        var fallbackUrl = string.IsNullOrWhiteSpace(_settings.BaseUrl)
            ? "http://127.0.0.1:7805"
            : _settings.BaseUrl;
        _client = new ChatClient(fallbackUrl, _settings.Token);
        SetStatus("内置服务没起来，尝试连已有服务", ok: false);

        if (!await _client.PingAsync())
        {
            var dlg = new ContentDialog
            {
                Title = "连不上服务",
                Content = new TextBlock
                {
                    Text = "内置服务没能启动，也没有找到已在运行的服务。\n\n" +
                           "可以这样处理：\n" +
                           "· 点「设置」手动填服务地址和 token\n" +
                           "· 或在仓库里跑：python tools/dev_chat.py --port 7805\n\n" +
                           "内置服务的输出：\n" + Truncate(_embedded.Log, 800),
                    TextWrapping = TextWrapping.Wrap,
                    IsTextSelectionEnabled = true,
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 12,
                },
                CloseButtonText = "知道了",
                XamlRoot = RootGrid().XamlRoot,
            };
            await dlg.ShowAsync();
        }
    }

    private Grid RootGrid() => (Grid)Content;

    private static string Truncate(string s, int n) =>
        string.IsNullOrEmpty(s) ? "（无输出）" : (s.Length <= n ? s : s[^n..]);

    private void StartPolling()
    {
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.5) };
        _timer.Tick += async (_, _) => await RefreshAsync(silent: true);
        _timer.Start();
    }

    // ================= 轮询 / 渲染 =================

    private async Task RefreshAsync(bool silent = false)
    {
        if (_client is null || _busy) return;
        try
        {
            var (total, messages) = await _client.GetMessagesAsync(_lastSeq);
            if (messages.Count > 0)
            {
                foreach (var m in messages)
                {
                    _all.Add(m);
                    if (m.Seq > _lastSeq) _lastSeq = m.Seq;
                }
                Render();
                UpdateNavCounts();
            }
            SetStatus($"共 {total} 条 · {DateTime.Now:HH:mm:ss}", ok: true);
        }
        catch (ChatException e)
        {
            SetStatus(e.Message, ok: false);
            if (!silent) ShowError(e.Message);
        }
    }

    private void BuildNav()
    {
        MemberList.Children.Clear();
        _nav.Clear();

        AddNavRow("", "全部", "#94908A", isAll: true);
        foreach (var m in Members.All)
            AddNavRow(m.Id, m.Name, m.ColorHex, isAll: false, role: m.Role);
    }

    private void AddNavRow(string id, string name, string colorKey, bool isAll, string? role = null)
    {
        var dot = new Ellipse
        {
            Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center,
            Fill = Theme.Res(colorKey),
        };

        var label = new TextBlock
        {
            Text = name, FontSize = 13, VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(7, 0, 0, 0),
            Foreground = Theme.Ink2(),
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = TextWrapping.NoWrap,
        };

        var count = new TextBlock
        {
            Text = "0", FontSize = 10, VerticalAlignment = VerticalAlignment.Center,
            Foreground = Theme.Dim(), Margin = new Thickness(6, 0, 0, 0),
        };

        var inner = new Grid();
        inner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        inner.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        inner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(dot, 0);
        Grid.SetColumn(label, 1);
        Grid.SetColumn(count, 2);
        inner.Children.Add(dot);
        inner.Children.Add(label);
        inner.Children.Add(count);

        var row = new Border
        {
            Padding = new Thickness(7, 6, 7, 6),
            CornerRadius = new CornerRadius(5),
            Child = inner,
            Background = new SolidColorBrush(Colors.Transparent),
            Tag = id,
        };
        ToolTipService.SetToolTip(row, role is null ? name : $"{name} · {role}");
        row.PointerEntered += (_, _) =>
        {
            if (NormalizeFilter(id) == _filter) return;
            row.Background = Theme.HoverBg();
            label.Foreground = Theme.Ink();
        };
        row.PointerExited += (_, _) =>
        {
            label.Foreground = Theme.Ink2();
            PaintNav();
        };
        row.Tapped += (_, _) =>
        {
            _filter = NormalizeFilter(id);
            PaintNav();
            Render();
        };

        MemberList.Children.Add(row);
        _nav[id] = (row, count, row);
        _navLabel[id] = label;
    }

    private static string? NormalizeFilter(string id) => string.IsNullOrEmpty(id) ? null : id;

    private void PaintNav()
    {
        foreach (var (id, (pill, _, _)) in _nav)
        {
            bool on = NormalizeFilter(id) == _filter;
            pill.Background = on ? Theme.SelBg() : new SolidColorBrush(Colors.Transparent);
            if (_navLabel.TryGetValue(id, out var lbl))
                lbl.Foreground = on ? Theme.Ink() : Theme.Ink2();
        }
    }

    private void UpdateNavCounts()
    {
        if (_nav.TryGetValue("", out var allEntry))
            allEntry.count.Text = _all.Count.ToString();

        foreach (var m in Members.All)
        {
            if (_nav.TryGetValue(m.Id, out var e))
                e.count.Text = _all.Count(x => x.Who == m.Id).ToString();
        }
    }

    private void Render()
    {
        FeedPanel.Children.Clear();

        var list = _filter is null
            ? _all.ToList()
            : _all.Where(m => m.Who == _filter).ToList();

        if (list.Count == 0)
        {
            FeedPanel.Children.Add(new TextBlock
            {
                Text = "还没有消息。\n\n四条线说话：\npython tools/dev_chat_say.py --who B --text \"…\"",
                FontSize = 13,
                Foreground = Theme.Dim(),
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 26,
            });
            return;
        }

        foreach (var m in list)
            FeedPanel.Children.Add(BuildMessageRow(m));

        if (_autoScroll)
            _ = DispatcherQueue.TryEnqueue(() => FeedScroll.ChangeView(null, FeedScroll.ScrollableHeight, null));
    }

    private UIElement BuildMessageRow(ChatMessage m)
    {
        var color = Theme.MemberBrush(m.Who);

        // 头像：圆角方块 + 一个字
        var avatar = new Border
        {
            Width = 26, Height = 26, CornerRadius = new CornerRadius(5),
            Background = color, VerticalAlignment = VerticalAlignment.Top,
            Child = new TextBlock
            {
                Text = m.Who,
                FontSize = 12, FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(Colors.White),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };

        // 第一行：名字 · 时间 [标签]
        var meta = new StackPanel
        {
            Orientation = Orientation.Horizontal, Spacing = 5,
            Margin = new Thickness(0, 0, 0, 1),
        };
        meta.Children.Add(new TextBlock
        {
            Text = m.Who, FontSize = 12, FontWeight = FontWeights.SemiBold,
            Foreground = color,
        });
        meta.Children.Add(new TextBlock
        {
            Text = "· " + m.ShortTime, FontSize = 11,
            Foreground = Theme.Dim(),
        });
        if (m.HasTag)
        {
            meta.Children.Add(new Border
            {
                Background = Theme.TagBg(),
                CornerRadius = new CornerRadius(3),
                Padding = new Thickness(5, 0, 5, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Child = new TextBlock
                {
                    Text = m.Tag, FontSize = 10,
                    Foreground = Theme.Ink2(),
                },
            });
        }

        // 正文：把 `code` 和 @人 拆成不同着色
        var textBlock = BuildRichText(m.Text);

        var body = new StackPanel { Spacing = 0 };
        body.Children.Add(meta);
        body.Children.Add(textBlock);

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(avatar, 0);
        Grid.SetColumn(body, 1);
        avatar.Margin = new Thickness(0, 0, 9, 0);
        grid.Children.Add(avatar);
        grid.Children.Add(body);
        return grid;
    }

    /// <summary>把反引号片段和 @成员 上色，其余保持正文色。</summary>
    private RichTextBlock BuildRichText(string text)
    {
        var rtb = new RichTextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            IsTextSelectionEnabled = true,
            FontSize = 14,
            LineHeight = 22,
        };
        var para = new Paragraph();
        rtb.Blocks.Add(para);

        int i = 0;
        while (i < text.Length)
        {
            // 反引号代码
            if (text[i] == '`')
            {
                int end = text.IndexOf('`', i + 1);
                if (end > i)
                {
                    var code = text.Substring(i + 1, end - i - 1);
                    AppendRun(para, code, "Consolas", 13, Theme.Ink2());
                    i = end + 1;
                    continue;
                }
            }

            // @成员
            if (text[i] == '@' && i + 1 < text.Length)
            {
                string? who = null;
                int len = 0;
                if (i + 1 < text.Length && "ABCD".Contains(text[i + 1]))
                {
                    who = text[i + 1].ToString();
                    len = 2;
                }
                else if (text[i + 1] == '你')
                {
                    who = "你";
                    len = 2;
                }
                if (who is not null)
                {
                    AppendRun(para, text.Substring(i, len), null, 14, Theme.MemberBrush(who),
                              bold: true);
                    i += len;
                    continue;
                }
            }

            // 普通文本：吃到下一个特殊字符
            int next = i;
            while (next < text.Length && text[next] != '`' && text[next] != '@') next++;
            if (next == i) next = i + 1;
            AppendRun(para, text.Substring(i, next - i), null, 14, Theme.Ink());
            i = next;
        }

        return rtb;
    }

    private static void AppendRun(Paragraph p, string text, string? font, double size,
                                  SolidColorBrush brush, bool bold = false)
    {
        var run = new Run { Text = text, FontSize = size, Foreground = brush };
        if (font is not null) run.FontFamily = new FontFamily(font);
        if (bold) run.FontWeight = FontWeights.SemiBold;
        p.Inlines.Add(run);
    }

    private void OnFeedScrolled(object? sender, ScrollViewerViewChangedEventArgs e)
    {
        // 滚到底附近才自动跟；用户往上翻时不打断
        _autoScroll = FeedScroll.ScrollableHeight - FeedScroll.VerticalOffset < 80;
    }

    // ================= 发送 =================

    private async void OnSendClick(object sender, RoutedEventArgs e) => await SendAsync();

    private void OnInputKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter &&
            (Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down) ||
             Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Menu)
                .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)))
        {
            e.Handled = true;
            _ = SendAsync();
        }
    }

    private async Task SendAsync()
    {
        if (_client is null || _busy) return;

        var text = InputBox.Text?.Trim() ?? "";
        if (text.Length == 0) return;

        string who = SelectedIdentity();
        _busy = true;
        SendButton.IsEnabled = false;
        try
        {
            var row = await _client.SayAsync(who, text);
            InputBox.Text = "";
            _all.Add(row);
            if (row.Seq > _lastSeq) _lastSeq = row.Seq;
            _autoScroll = true;
            Render();
            UpdateNavCounts();
        }
        catch (ChatException e)
        {
            ShowError(e.Message);
        }
        finally
        {
            _busy = false;
            SendButton.IsEnabled = true;
            InputBox.Focus(FocusState.Programmatic);
        }
    }

    private string SelectedIdentity()
    {
        if (WhoBox.SelectedItem is ComboBoxItem item && item.Tag is string id)
            return id;
        return "你";
    }

    private void SelectIdentity(string id)
    {
        for (int i = 0; i < WhoBox.Items.Count; i++)
        {
            if (WhoBox.Items[i] is ComboBoxItem it && (string?)it.Tag == id)
            {
                WhoBox.SelectedIndex = i;
                return;
            }
        }
        WhoBox.SelectedIndex = WhoBox.Items.Count - 1;  // 默认「你」
    }

    private void OnWhoChanged(object sender, SelectionChangedEventArgs e)
    {
        _settings.Identity = SelectedIdentity();
        _settings.Save();
    }

    // ================= 状态 / 错误 =================

    private void SetStatus(string text, bool ok)
    {
        StatusText.Text = text;
        StatusDot.Fill = ok ? Theme.Ok() : Theme.Bad();
    }

    private async void ShowError(string message)
    {
        try
        {
            var dlg = new ContentDialog
            {
                Title = "出错了",
                Content = new TextBlock
                {
                    Text = message, TextWrapping = TextWrapping.Wrap,
                    IsTextSelectionEnabled = true,
                },
                CloseButtonText = "知道了",
                XamlRoot = RootGrid().XamlRoot,
            };
            await dlg.ShowAsync();
        }
        catch { /* 窗口可能已关 */ }
    }

    private void BuildMembers()
    {
        // 侧栏在 BuildNav 里生成；这里留空以保持结构对称
    }

    // ================= 设置 =================

    private async void OnSettingsClick(object sender, RoutedEventArgs e)
    {
        var modeSwitch = new ToggleSwitch
        {
            Header = "由本应用启动本地服务",
            OnContent = "是", OffContent = "否",
            IsOn = _settings.EmbeddedMode,
        };
        var urlBox = new TextBox
        {
            Header = "服务地址（内置模式会覆盖）",
            Text = _settings.BaseUrl ?? "",
            PlaceholderText = "http://127.0.0.1:7805",
        };
        var tokenBox = new TextBox
        {
            Header = "token（服务要求鉴权时填）",
            Text = _settings.Token ?? "",
            PlaceholderText = "留空表示不需要",
        };
        var repoBox = new TextBox
        {
            Header = "仓库根（内置模式用，留空自动找）",
            Text = _settings.RepoRoot ?? "",
            PlaceholderText = "含 tools/dev_chat.py 的目录",
        };
        var pyBox = new TextBox
        {
            Header = "python.exe（留空自动找 .deps/venv）",
            Text = _settings.PythonPath ?? "",
        };
        var note = new TextBlock
        {
            Text = "改完点「保存」会立即生效并重连。",
            FontSize = 12, Foreground = Theme.Dim(),
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0),
        };

        var panel = new StackPanel { Spacing = 12, Width = 460 };
        panel.Children.Add(modeSwitch);
        panel.Children.Add(urlBox);
        panel.Children.Add(tokenBox);
        panel.Children.Add(repoBox);
        panel.Children.Add(pyBox);
        panel.Children.Add(note);

        var dlg = new ContentDialog
        {
            Title = "设置",
            Content = new ScrollViewer { Content = panel, MaxHeight = 460 },
            PrimaryButtonText = "保存",
            CloseButtonText = "取消",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = RootGrid().XamlRoot,
        };

        if (await dlg.ShowAsync() != ContentDialogResult.Primary) return;

        _settings.EmbeddedMode = modeSwitch.IsOn;
        _settings.BaseUrl = urlBox.Text.Trim();
        _settings.Token = tokenBox.Text.Trim();
        _settings.RepoRoot = repoBox.Text.Trim();
        _settings.PythonPath = pyBox.Text.Trim();
        _settings.Save();

        // 立即重连
        _embedded.Kill();
        _client?.Dispose();
        _client = null;
        _all.Clear();
        _lastSeq = 0;
        Render();
        UpdateNavCounts();

        if (_settings.EmbeddedMode) await StartEmbeddedAsync();
        else _client = new ChatClient(_settings.BaseUrl, _settings.Token);

        await RefreshAsync();
    }

    // ================= 关闭 =================

    private void OnClosed(object sender, WindowEventArgs args)
    {
        _timer?.Stop();
        _settings.WindowWidth = AppWindow.Size.Width;
        _settings.WindowHeight = AppWindow.Size.Height;
        _settings.Save();
        _client?.Dispose();
        _embedded.Dispose();
    }
}
