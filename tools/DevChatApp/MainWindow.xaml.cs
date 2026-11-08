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
        _settings.FillLocator();
        Title = "开发群聊";

        // 主题资源挂在窗口根元素上，先接上再建任何带颜色的控件
        Theme.Attach(RootGrid());

        ApplyWindowIcon();

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

    // ================= 图标 =================

    /// <summary>
    /// 给窗口设图标。&lt;ApplicationIcon&gt; 只换 exe 在资源管理器里的图标，
    /// 任务栏和窗口左上角要单独设，否则仍显示默认图标。
    /// </summary>
    private void ApplyWindowIcon()
    {
        try
        {
            var ico = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
            if (!File.Exists(ico)) return;

            var hwnd = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
            int w = GetSystemMetrics(SM_CXICON);
            int h = GetSystemMetrics(SM_CYICON);
            var small = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, w, h, LR_LOADFROMFILE);
            if (small != IntPtr.Zero)
                SendMessage(hwnd, WM_SETICON, ICON_BIG, small);

            int sw = GetSystemMetrics(SM_CXSMICON);
            int sh = GetSystemMetrics(SM_CYSMICON);
            var smallIco = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, sw, sh, LR_LOADFROMFILE);
            if (smallIco != IntPtr.Zero)
                SendMessage(hwnd, WM_SETICON, ICON_SMALL, smallIco);
        }
        catch { /* 图标设不上不影响用 */ }
    }

    private const int WM_SETICON = 0x0080;
    private const int ICON_SMALL = 0;
    private const int ICON_BIG = 1;
    private const int IMAGE_ICON = 1;
    private const uint LR_LOADFROMFILE = 0x0010;
    private const int SM_CXICON = 11;
    private const int SM_CYICON = 12;
    private const int SM_CXSMICON = 49;
    private const int SM_CYSMICON = 50;

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr LoadImage(IntPtr hinst, string name, int type, int cx, int cy, uint flags);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, IntPtr lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

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

        // ⚠ 关键：OnActivated 触发时视觉树可能还没好，XamlRoot 还是 null。
        // 那时候弹 ContentDialog 会抛「This element does not have a XamlRoot」
        // 并让整个进程崩掉（0xc000027b）。先等根元素 Loaded 再干活的。
        var root = RootGrid();
        if (root.XamlRoot is null)
        {
            var tcs = new TaskCompletionSource<bool>();
            RoutedEventHandler? handler = null;
            handler = (_, _) =>
            {
                root.Loaded -= handler;
                tcs.TrySetResult(true);
            };
            root.Loaded += handler;
            // 兜底：500ms 后无论如何继续（避免 Loaded 不触发时卡死）
            var done = await Task.WhenAny(tcs.Task, Task.Delay(800));
            if (done != tcs.Task) root.Loaded -= handler;
        }

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

        // 仓库根：优先用定位配置（发布版），否则从 exe 往上找（开发态）
        var repo = _settings.RepoRoot;
        if (string.IsNullOrWhiteSpace(repo) || !Directory.Exists(repo))
        {
            repo = EmbeddedServer.FindRepoRoot() ?? "";
            if (!string.IsNullOrWhiteSpace(repo)) _settings.RepoRoot = repo;
        }

        // 日志与仓库里那份共用，避免出现「两个房间」
        string logPath;
        if (!string.IsNullOrWhiteSpace(repo) && Directory.Exists(repo))
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

        var ok = await _embedded.StartAsync(repo, _settings.PythonPath, logPath);
        if (ok && _embedded.BaseUrl is { } url)
        {
            _settings.BaseUrl = url;
            _settings.Token = _embedded.Token ?? "";
            _client = new ChatClient(url, _settings.Token);
            SetStatus("本地服务已就绪", ok: true);
            return;
        }

        // 内置失败 → 尝试连一个已经在跑的服务。
        // ⚠ 这里原来兜底成 http://127.0.0.1:7805，但用户机器上 7805 未必在跑，
        // 于是就报「连不上 (127.0.0.1:7805)」，看起来像 bug 其实是猜错了端口。
        // 现在只认真实配置过的地址，不猜。
        var fallbackUrl = _settings.BaseUrl;
        var canFallback = !string.IsNullOrWhiteSpace(fallbackUrl)
                          && _settings.EmbeddedMode == false;
        if (canFallback)
        {
            _client = new ChatClient(fallbackUrl!, _settings.Token);
            SetStatus("内置服务没起来，尝试连已有服务", ok: false);
            if (await _client.PingAsync()) return;
        }

        // 到这说明确实没服务可用。给出准确的手工指引，不猜端口。
        _client = null;
        SetStatus("没有可用的服务", ok: false);

        var root = RootGrid();
        if (root.XamlRoot is null)
        {
            // 连弹窗都弹不了（视觉树没就绪），只把原因写进状态栏 + 崩溃日志旁
            SetStatus("启动不了群聊服务：找不到仓库根。跑 tools/make_devchat_locator.py", ok: false);
            return;
        }

        var repoLine = string.IsNullOrWhiteSpace(repo)
            ? "（没找到）"
            : repo;
        var dlg = new ContentDialog
        {
            Title = "启动不了群聊服务",
            Content = new ScrollViewer
            {
                MaxHeight = 420,
                Content = new TextBlock
                {
                    Text =
                        "找不到仓库根，或仓库根里没有 tools/dev_chat.py。\n\n" +
                        "仓库根（当前）：\n" + repoLine + "\n\n" +
                        "python（当前）：\n" +
                        (string.IsNullOrWhiteSpace(_settings.PythonPath) ? "（没找到）" : _settings.PythonPath) +
                        "\n\n" +
                        "两种修法：\n\n" +
                        "① 自动（推荐）\n" +
                        "   在仓库里跑一次：\n" +
                        "   python tools/make_devchat_locator.py\n" +
                        "   它会在 exe 同目录写 devchat.json，钉死仓库根和 python。\n\n" +
                        "② 手动\n" +
                        "   点下面的「打开设置」，填「仓库根」和「python.exe」。\n\n" +
                        "内置服务的输出：\n" + Truncate(_embedded.Log, 900),
                    TextWrapping = TextWrapping.Wrap,
                    IsTextSelectionEnabled = true,
                    FontSize = 12,
                },
            },
            PrimaryButtonText = "打开设置",
            CloseButtonText = "知道了",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = root.XamlRoot,
        };
        if (await dlg.ShowAsync() == ContentDialogResult.Primary)
            await ShowSettingsAsync();
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
            var root = RootGrid();
            // XamlRoot 还没好时不能弹，否则整个进程崩
            if (root.XamlRoot is null)
            {
                SetStatus(message, ok: false);
                return;
            }
            var dlg = new ContentDialog
            {
                Title = "出错了",
                Content = new TextBlock
                {
                    Text = message, TextWrapping = TextWrapping.Wrap,
                    IsTextSelectionEnabled = true,
                },
                CloseButtonText = "知道了",
                XamlRoot = root.XamlRoot,
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

    private async void OnSettingsClick(object sender, RoutedEventArgs e) => await ShowSettingsAsync();

    private async Task ShowSettingsAsync()
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
