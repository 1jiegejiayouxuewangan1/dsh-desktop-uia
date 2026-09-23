// DshUia engine: Windows UI Automation operations behind the JSON-RPC sidecar.
//
// Compiled with the in-box .NET Framework C# 5 compiler (no SDK, no NuGet).
// Every public entry point takes the request `params` dictionary and returns a
// JSON-serializable object graph built from Dictionary<string, object> / List<object>.
//
// Design notes that matter for correctness:
//  * The process becomes per-monitor DPI aware before any UIA call, so
//    BoundingRectangle and cursor coordinates share one physical-pixel space.
//  * Elements are identified by a stable `el_NNN` id keyed on the UIA runtime
//    id, so ids survive re-snapshots of the same window and stay usable for
//    follow-up actions.
//  * A snapshot reads the whole subtree through one activated cache request,
//    which keeps a full tree at a single cross-process round trip.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

using D = System.Collections.Generic.Dictionary<string, object>;

namespace DshUia
{
    /// <summary>A code/message/hint failure that is safe to hand straight to the model.</summary>
    internal sealed class Fail : Exception
    {
        public readonly string Code;
        public readonly string Hint;

        public Fail(string code, string message, string hint)
            : base(message)
        {
            this.Code = code;
            this.Hint = hint;
        }
    }

    #region native

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    internal struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct INPUT { public uint type; public INPUTUNION u; }

    internal static class Native
    {
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int DWMWA_CLOAKED = 14;
        public const uint GA_ROOT = 2;
        public const int INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const int SW_RESTORE = 9;
        public const int SW_MINIMIZE = 6;
        public const int SW_MAXIMIZE = 3;
        public const int SW_SHOW = 5;
        public const int SW_HIDE = 0;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_SHOWWINDOW = 0x0040;
        public const int HWND_TOPMOST = -1;
        public const int HWND_NOTOPMOST = -2;
        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;
        public const int SM_CMONITORS = 80;
        public const uint WM_CLOSE = 0x0010;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
        [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
        [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
        [DllImport("shcore.dll")] public static extern int GetProcessDpiAwareness(IntPtr process, out int value);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

        public static string ClassOf(IntPtr hWnd)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassNameW(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string TitleOf(IntPtr hWnd)
        {
            int len = GetWindowTextLengthW(hWnd);
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        public static bool IsCloaked(IntPtr hWnd)
        {
            try
            {
                int value = 0;
                int hr = DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out value, sizeof(int));
                return hr == 0 && value != 0;
            }
            catch { return false; }
        }
    }

    #endregion

    #region argument helpers

    internal static class A
    {
        public static D AsDict(object value)
        {
            return value as D;
        }

        public static D Dict(D owner, string key)
        {
            if (owner == null || !owner.ContainsKey(key)) return null;
            return AsDict(owner[key]);
        }

        public static bool Has(D owner, string key)
        {
            return owner != null && owner.ContainsKey(key) && owner[key] != null;
        }

        public static string Str(D owner, string key, string fallback)
        {
            if (!Has(owner, key)) return fallback;
            object v = owner[key];
            if (v == null) return fallback;
            string s = v as string;
            if (s != null) return s;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static long Long(D owner, string key, long fallback)
        {
            if (!Has(owner, key)) return fallback;
            object v = owner[key];
            if (v == null) return fallback;
            try
            {
                string s = v as string;
                if (s != null)
                {
                    s = s.Trim();
                    if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                        return long.Parse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                    long parsed;
                    if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
                    return fallback;
                }
                return Convert.ToInt64(v, CultureInfo.InvariantCulture);
            }
            catch { return fallback; }
        }

        public static int Int(D owner, string key, int fallback)
        {
            long value = Long(owner, key, fallback);
            if (value > int.MaxValue) return int.MaxValue;
            if (value < int.MinValue) return int.MinValue;
            return (int)value;
        }

        public static bool Bool(D owner, string key, bool fallback)
        {
            if (!Has(owner, key)) return fallback;
            object v = owner[key];
            if (v is bool) return (bool)v;
            string s = v as string;
            if (s != null) return string.Equals(s, "true", StringComparison.OrdinalIgnoreCase);
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture) != 0; }
            catch { return fallback; }
        }

        public static D New()
        {
            return new D(StringComparer.Ordinal);
        }

        public static D Put(D target, string key, object value)
        {
            if (target != null && value != null) target[key] = value;
            return target;
        }

        public static D PutAlways(D target, string key, object value)
        {
            if (target != null) target[key] = value;
            return target;
        }

        public static string Clip(string value, int max)
        {
            if (value == null) return "";
            if (value.Length <= max) return value;
            return value.Substring(0, max - 1) + "...";
        }
    }

    #endregion

    #region element registry

    /// <summary>
    /// Stable element ids: one runtime id maps to one `el_NNN` for the process
    /// lifetime, so an id captured by one snapshot still resolves after the UI
    /// changed and the agent takes a fresh snapshot.
    /// </summary>
    internal static class Registry
    {
        private static readonly object gate = new object();
        private static readonly Dictionary<string, AutomationElement> byId = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
        private static readonly Dictionary<string, string> idByRuntime = new Dictionary<string, string>(StringComparer.Ordinal);
        private static readonly Dictionary<string, long> touched = new Dictionary<string, long>(StringComparer.Ordinal);
        private static long counter;
        private const int MaxEntries = 4000;

        private static string RuntimeKey(AutomationElement el)
        {
            int[] runtime = el.GetRuntimeId();
            if (runtime == null || runtime.Length == 0) return null;
            StringBuilder sb = new StringBuilder(64);
            sb.Append(el.Current.ProcessId).Append(':');
            for (int i = 0; i < runtime.Length; i++)
            {
                if (i > 0) sb.Append('.');
                sb.Append(runtime[i]);
            }
            return sb.ToString();
        }

        public static string Register(AutomationElement el)
        {
            if (el == null) return null;
            string runtimeKey = null;
            try { runtimeKey = RuntimeKey(el); }
            catch { }
            lock (gate)
            {
                if (runtimeKey != null)
                {
                    string existing;
                    if (idByRuntime.TryGetValue(runtimeKey, out existing))
                    {
                        byId[existing] = el;
                        touched[existing] = Environment.TickCount;
                        return existing;
                    }
                }
                counter += 1;
                string id = "el_" + counter.ToString(CultureInfo.InvariantCulture);
                byId[id] = el;
                touched[id] = Environment.TickCount;
                if (runtimeKey != null) idByRuntime[runtimeKey] = id;
                if (byId.Count > MaxEntries) PurgeLocked();
                return id;
            }
        }

        public static bool TryGet(string id, out AutomationElement el)
        {
            el = null;
            if (string.IsNullOrEmpty(id)) return false;
            lock (gate)
            {
                if (!byId.TryGetValue(id, out el)) return false;
                touched[id] = Environment.TickCount;
                return true;
            }
        }

        public static AutomationElement Require(string id, string what)
        {
            AutomationElement el;
            if (!TryGet(id, out el))
                throw new Fail("UNKNOWN_ELEMENT",
                    "unknown element id " + (id == null ? "(missing)" : id) + " for " + what,
                    "Element ids come from desktop_snapshot; take a fresh snapshot and use an id from it.");
            try { int pid = el.Current.ProcessId; }
            catch (ElementNotAvailableException)
            {
                Forget(id);
                throw new Fail("STALE_ELEMENT",
                    "element " + id + " no longer exists (" + what + ")",
                    "The window changed since that snapshot. Run desktop_snapshot again and pick a current id.");
            }
            return el;
        }

        public static void Forget(string id)
        {
            if (id == null) return;
            lock (gate) { byId.Remove(id); touched.Remove(id); }
        }

        private static void PurgeLocked()
        {
            long now = Environment.TickCount;
            List<string> stale = new List<string>();
            foreach (KeyValuePair<string, long> entry in touched)
            {
                if (now - entry.Value > 600000) stale.Add(entry.Key);
            }
            if (stale.Count == 0)
            {
                List<KeyValuePair<string, long>> all = new List<KeyValuePair<string, long>>(touched);
                all.Sort(delegate(KeyValuePair<string, long> x, KeyValuePair<string, long> y) { return x.Value.CompareTo(y.Value); });
                int drop = Math.Max(1, all.Count / 4);
                for (int i = 0; i < drop && i < all.Count; i++) stale.Add(all[i].Key);
            }
            for (int i = 0; i < stale.Count; i++)
            {
                byId.Remove(stale[i]);
                touched.Remove(stale[i]);
            }
        }

        public static int Count
        {
            get { lock (gate) { return byId.Count; } }
        }
    }

    #endregion

    #region windows

    internal static class Win
    {
        private static readonly Dictionary<int, string> processNames = new Dictionary<int, string>();

        public static List<IntPtr> Enumerate(bool includeUntitled)
        {
            List<IntPtr> rest = new List<IntPtr>();
            List<IntPtr> foregroundFirst = new List<IntPtr>();
            IntPtr foreground = Native.GetForegroundWindow();
            Native.EnumWindowsProc cb = delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (Native.IsCloaked(hWnd)) return true;
                string cls = Native.ClassOf(hWnd);
                if (cls == "Shell_TrayWnd" || cls == "Progman" || cls == "WorkerW" || cls == "Windows.UI.Core.CoreWindow") return true;
                string title = Native.TitleOf(hWnd);
                if (title.Length == 0)
                {
                    int ex = Native.GetWindowLong(hWnd, Native.GWL_EXSTYLE);
                    bool toolWindow = (ex & Native.WS_EX_TOOLWINDOW) != 0;
                    if (toolWindow || !includeUntitled) return true;
                }
                if (hWnd == foreground && title.Length > 0) foregroundFirst.Add(hWnd);
                else rest.Add(hWnd);
                return true;
            };
            Native.EnumWindows(cb, IntPtr.Zero);
            List<IntPtr> ordered = new List<IntPtr>();
            ordered.AddRange(foregroundFirst);
            ordered.AddRange(rest);
            return ordered;
        }

        public static D Describe(IntPtr hWnd, bool deep)
        {
            D info = A.New();
            if (hWnd == IntPtr.Zero)
            {
                A.Put(info, "title", "(none)");
                return info;
            }
            A.Put(info, "hwnd", "0x" + hWnd.ToInt64().ToString("X", CultureInfo.InvariantCulture));
            uint pid;
            Native.GetWindowThreadProcessId(hWnd, out pid);
            A.Put(info, "pid", (long)pid);
            A.Put(info, "process", ProcessNameOf((int)pid));
            A.Put(info, "title", Native.TitleOf(hWnd));
            A.Put(info, "class", Native.ClassOf(hWnd));
            if (hWnd == Native.GetForegroundWindow()) A.Put(info, "foreground", true);
            if (Native.IsIconic(hWnd)) A.Put(info, "minimized", true);
            if (Native.IsZoomed(hWnd)) A.Put(info, "maximized", true);
            RECT r;
            if (Native.GetWindowRect(hWnd, out r))
            {
                D rect = A.New();
                A.Put(rect, "x", r.Left);
                A.Put(rect, "y", r.Top);
                A.Put(rect, "w", r.Right - r.Left);
                A.Put(rect, "h", r.Bottom - r.Top);
                A.Put(info, "rect", rect);
            }
            if (deep)
            {
                try
                {
                    AutomationElement el = AutomationElement.FromHandle(hWnd);
                    if (el != null)
                    {
                        A.Put(info, "elementId", Registry.Register(el));
                        A.Put(info, "name", el.Current.Name);
                        A.Put(info, "type", ShortType(el.Current.ControlType));
                    }
                }
                catch (Exception ex) { A.Put(info, "readError", MessageOf(ex, (int)pid)); }
            }
            return info;
        }

        public static string ProcessNameOf(int pid)
        {
            lock (processNames)
            {
                string cached;
                if (processNames.TryGetValue(pid, out cached)) return cached;
            }
            string name = "";
            try
            {
                using (Process p = Process.GetProcessById(pid)) name = p.ProcessName;
            }
            catch { }
            lock (processNames)
            {
                if (processNames.Count > 512) processNames.Clear();
                processNames[pid] = name;
            }
            return name;
        }

        /// <summary>Turn a raw UIA failure into the sentence the model needs.</summary>
        public static string MessageOf(Exception ex, int pid)
        {
            if (ex is ElementNotAvailableException)
                return "the window or element disappeared before it could be read";
            if (ex is UnauthorizedAccessException)
                return "access denied reading pid " + pid.ToString(CultureInfo.InvariantCulture)
                    + ": the target runs elevated while DSH does not. Start DSH as administrator to control elevated apps.";
            COMException com = ex as COMException;
            if (com != null && (uint)com.ErrorCode == 0x80070005)
                return "access denied reading pid " + pid.ToString(CultureInfo.InvariantCulture)
                    + ": the target runs elevated while DSH does not. Start DSH as administrator to control elevated apps.";
            return ex.GetType().Name + ": " + ex.Message;
        }

        public static string ShortType(ControlType type)
        {
            string full = type == null ? null : type.ProgrammaticName;
            const string prefix = "ControlType.";
            if (full != null && full.StartsWith(prefix, StringComparison.Ordinal)) return full.Substring(prefix.Length);
            return full;
        }

        /// <summary>Resolve a window from `hwnd` | `pid` (+ optional `title`/`index`) | `title` | the foreground window.</summary>
        public static IntPtr Resolve(D p, out D info)
        {
            info = null;
            if (A.Has(p, "hwnd"))
            {
                long raw = A.Long(p, "hwnd", 0);
                IntPtr h = new IntPtr(raw);
                if (!Native.IsWindow(h))
                    throw new Fail("WINDOW_NOT_FOUND",
                        "hwnd " + raw.ToString(CultureInfo.InvariantCulture) + " is not an open window",
                        "Call desktop_windows to list live handles.");
                info = Describe(h, true);
                return h;
            }

            bool hasPid = A.Has(p, "pid") && A.Int(p, "pid", 0) != 0;
            bool hasTitle = A.Has(p, "title") && !string.IsNullOrEmpty(A.Str(p, "title", null));
            int wantPid = A.Int(p, "pid", 0);
            string wantTitle = A.Str(p, "title", null);
            string titleMode = A.Str(p, "titleMode", "contains");
            int index = A.Int(p, "index", 0);

            if (!hasPid && !hasTitle)
            {
                IntPtr fg = Native.GetForegroundWindow();
                if (fg == IntPtr.Zero) throw new Fail("NO_WINDOW", "no foreground window", "Pass window {title: \"...\"} or window {pid: N}.");
                info = Describe(fg, true);
                return fg;
            }

            List<IntPtr> candidates = Enumerate(true);
            List<IntPtr> matches = new List<IntPtr>();
            for (int i = 0; i < candidates.Count; i++)
            {
                IntPtr h = candidates[i];
                if (hasPid)
                {
                    uint pid;
                    Native.GetWindowThreadProcessId(h, out pid);
                    if ((int)pid != wantPid) continue;
                }
                if (hasTitle && !TitleMatches(Native.TitleOf(h), wantTitle, titleMode)) continue;
                matches.Add(h);
            }

            if (matches.Count == 0)
            {
                string what = hasTitle ? "title \"" + wantTitle + "\"" : "pid " + wantPid.ToString(CultureInfo.InvariantCulture);
                throw new Fail("WINDOW_NOT_FOUND", "no window matches " + what,
                    "Call desktop_windows to see live windows; titles change, so fall back to pid or hwnd.");
            }

            IntPtr chosen;
            if (matches.Count == 1) chosen = matches[0];
            else
            {
                IntPtr foreground = Native.GetForegroundWindow();
                if (index == 0 && matches.Contains(foreground)) chosen = foreground;
                else if (index >= 0 && index < matches.Count) chosen = matches[index];
                else
                    throw new Fail("WINDOW_AMBIGUOUS",
                        matches.Count.ToString(CultureInfo.InvariantCulture) + " windows match; index "
                        + index.ToString(CultureInfo.InvariantCulture) + " is out of range",
                        Candidates(matches));
            }
            info = Describe(chosen, true);
            if (matches.Count > 1) A.Put(info, "matchCount", matches.Count);
            return chosen;
        }

        private static string Candidates(List<IntPtr> matches)
        {
            StringBuilder sb = new StringBuilder("Matches: ");
            int limit = Math.Min(matches.Count, 8);
            for (int i = 0; i < limit; i++)
            {
                if (i > 0) sb.Append("; ");
                D d = Describe(matches[i], false);
                sb.Append("index=").Append(i)
                  .Append(" pid=").Append(Convert.ToString(d["pid"], CultureInfo.InvariantCulture))
                  .Append(" title=\"").Append(Convert.ToString(d["title"], CultureInfo.InvariantCulture)).Append("\"");
            }
            sb.Append(". Pass index, pid or hwnd to disambiguate.");
            return sb.ToString();
        }

        private static bool TitleMatches(string title, string want, string mode)
        {
            if (title == null) title = "";
            if (mode == "equals") return string.Equals(title, want, StringComparison.OrdinalIgnoreCase);
            if (mode == "regex")
            {
                try { return Regex.IsMatch(title, want, RegexOptions.IgnoreCase); }
                catch (ArgumentException) { return false; }
            }
            return title.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static IntPtr HwndOf(AutomationElement el)
        {
            if (el == null) return IntPtr.Zero;
            try
            {
                AutomationElement cursor = el;
                for (int i = 0; i < 64 && cursor != null; i++)
                {
                    int handle = cursor.Current.NativeWindowHandle;
                    if (handle != 0) return new IntPtr(handle);
                    cursor = TreeWalker.ControlViewWalker.GetParent(cursor);
                }
            }
            catch { }
            return IntPtr.Zero;
        }

        /// <summary>Best-effort foreground activation; the OS focus-stealing guard makes this advisory.</summary>
        public static bool Focus(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return false;
            if (Native.IsIconic(hWnd)) Native.ShowWindow(hWnd, Native.SW_RESTORE);
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == hWnd) return true;
            uint ignored;
            uint targetThread = Native.GetWindowThreadProcessId(hWnd, out ignored);
            uint thisThread = Native.GetCurrentThreadId();
            uint fgThread = fg == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(fg, out ignored);
            bool attached = false;
            try
            {
                if (fgThread != 0 && fgThread != thisThread)
                    attached = Native.AttachThreadInput(thisThread, fgThread, true);
                Native.BringWindowToTop(hWnd);
                Native.SetForegroundWindow(hWnd);
                Native.SetFocus(hWnd);
            }
            catch { }
            finally
            {
                if (attached)
                {
                    try { Native.AttachThreadInput(thisThread, fgThread, false); }
                    catch { }
                }
            }
            Thread.Sleep(60);
            return Native.GetForegroundWindow() == hWnd;
        }
    }

    #endregion

    #region input

    internal static class Input
    {
        private static readonly Dictionary<string, ushort> vkNames = BuildKeyMap();

        private static Dictionary<string, ushort> BuildKeyMap()
        {
            Dictionary<string, ushort> m = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            m["backspace"] = 0x08; m["tab"] = 0x09; m["enter"] = 0x0D; m["return"] = 0x0D;
            m["shift"] = 0x10; m["ctrl"] = 0x11; m["control"] = 0x11; m["alt"] = 0x12; m["pause"] = 0x13;
            m["capslock"] = 0x14; m["esc"] = 0x1B; m["escape"] = 0x1B; m["space"] = 0x20;
            m["pageup"] = 0x21; m["pgup"] = 0x21; m["pagedown"] = 0x22; m["pgdn"] = 0x22;
            m["end"] = 0x23; m["home"] = 0x24; m["left"] = 0x25; m["up"] = 0x26; m["right"] = 0x27; m["down"] = 0x28;
            m["insert"] = 0x2D; m["delete"] = 0x2E; m["del"] = 0x2E;
            m["win"] = 0x5B; m["lwin"] = 0x5B; m["rwin"] = 0x5C; m["apps"] = 0x5D;
            m["num0"] = 0x60; m["num1"] = 0x61; m["num2"] = 0x62; m["num3"] = 0x63; m["num4"] = 0x64;
            m["num5"] = 0x65; m["num6"] = 0x66; m["num7"] = 0x67; m["num8"] = 0x68; m["num9"] = 0x69;
            m["numlock"] = 0x90; m["scrolllock"] = 0x91; m["printscreen"] = 0x2C;
            m["semicolon"] = 0xBA; m["equals"] = 0xBB; m["comma"] = 0xBC;
            m["minus"] = 0xBD; m["period"] = 0xBE; m["slash"] = 0xBF; m["backtick"] = 0xC0;
            m["bracketleft"] = 0xDB; m["bracketright"] = 0xDD; m["backslash"] = 0xDC; m["quote"] = 0xDE;
            for (ushort code = 0x30; code <= 0x39; code++) m[((char)code).ToString()] = code;
            for (ushort code = 0x41; code <= 0x5A; code++) m[((char)code).ToString()] = code;
            for (int i = 1; i <= 24; i++) m["f" + i.ToString(CultureInfo.InvariantCulture)] = (ushort)(0x6F + i);
            return m;
        }

        public static void MoveTo(int x, int y)
        {
            Native.SetCursorPos(x, y);
            Native.mouse_event(Native.MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
        }

        private static bool IsExtended(ushort vk)
        {
            return vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E
                || vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x5B || vk == 0x5C || vk == 0x5D
                || vk == 0x6F || vk == 0x2C;
        }

        private static void SendKey(ushort vk, bool keyUp)
        {
            INPUT[] one = new INPUT[1];
            one[0].type = Native.INPUT_KEYBOARD;
            one[0].u.ki.wVk = vk;
            one[0].u.ki.wScan = 0;
            uint flags = 0;
            if (IsExtended(vk)) flags |= Native.KEYEVENTF_EXTENDEDKEY;
            if (keyUp) flags |= Native.KEYEVENTF_KEYUP;
            one[0].u.ki.dwFlags = flags;
            one[0].u.ki.time = 0;
            one[0].u.ki.dwExtraInfo = IntPtr.Zero;
            Native.SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
        }

        public static int PressCombo(string spec, int settleMs)
        {
            if (string.IsNullOrEmpty(spec))
                throw new Fail("BAD_KEY", "empty key specification", "Use forms like \"enter\", \"ctrl+s\", \"ctrl+shift+escape\".");
            string[] parts = spec.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            List<ushort> keys = new List<ushort>();
            for (int i = 0; i < parts.Length; i++)
            {
                string token = parts[i].Trim();
                if (token.Length == 0) continue;
                ushort vk;
                if (!vkNames.TryGetValue(token, out vk))
                    throw new Fail("BAD_KEY", "unknown key or modifier \"" + token + "\"",
                        "Recognised: letters, digits, f1-f24, enter, tab, esc, space, backspace, delete, insert, home, end, pageup, pagedown, arrows, ctrl, alt, shift, win, printscreen, and punctuation names such as comma, period, slash, semicolon, minus, equals, backslash, backtick, bracketleft, bracketright, quote.");
                keys.Add(vk);
            }
            if (keys.Count == 0)
                throw new Fail("BAD_KEY", "no keys in \"" + spec + "\"", "Use a form like \"enter\" or \"ctrl+s\".");
            for (int i = 0; i < keys.Count; i++) SendKey(keys[i], false);
            Thread.Sleep(Math.Max(8, settleMs / 2));
            for (int i = keys.Count - 1; i >= 0; i--) SendKey(keys[i], true);
            Thread.Sleep(Math.Max(8, settleMs));
            return keys.Count;
        }

        public static void TypeText(string text, int settleMs)
        {
            if (text == null) return;
            for (int index = 0; index < text.Length; index++)
            {
                int cp = text[index];
                if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
                {
                    cp = char.ConvertToUtf32(text[index], text[index + 1]);
                    index++;
                }
                if (cp == '\n') { PressCombo("enter", settleMs); continue; }
                if (cp == '\t') { PressCombo("tab", settleMs); continue; }
                if (cp == '\r') continue;
                SendUnicode(cp, settleMs);
            }
        }

        private static void SendUnicode(int codePoint, int settleMs)
        {
            INPUT[] seq = new INPUT[2];
            for (int i = 0; i < 2; i++)
            {
                seq[i].type = Native.INPUT_KEYBOARD;
                seq[i].u.ki.wVk = 0;
                seq[i].u.ki.wScan = (ushort)codePoint;
                uint flags = Native.KEYEVENTF_UNICODE;
                if (i == 1) flags |= Native.KEYEVENTF_KEYUP;
                seq[i].u.ki.dwFlags = flags;
                seq[i].u.ki.time = 0;
                seq[i].u.ki.dwExtraInfo = IntPtr.Zero;
            }
            Native.SendInput(2, seq, Marshal.SizeOf(typeof(INPUT)));
            int pause = settleMs / 8;
            if (pause > 1) Thread.Sleep(pause);
        }

        public static void Click(int x, int y, string button, int clicks, int settleMs)
        {
            MoveTo(x, y);
            Thread.Sleep(Math.Max(10, settleMs / 2));
            uint down = Native.MOUSEEVENTF_LEFTDOWN;
            uint up = Native.MOUSEEVENTF_LEFTUP;
            if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) { down = Native.MOUSEEVENTF_RIGHTDOWN; up = Native.MOUSEEVENTF_RIGHTUP; }
            else if (string.Equals(button, "middle", StringComparison.OrdinalIgnoreCase)) { down = Native.MOUSEEVENTF_MIDDLEDOWN; up = Native.MOUSEEVENTF_MIDDLEUP; }
            int count = Math.Max(1, Math.Min(clicks, 3));
            for (int i = 0; i < count; i++)
            {
                Native.mouse_event(down, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(16);
                Native.mouse_event(up, 0, 0, 0, UIntPtr.Zero);
                if (i + 1 < count) Thread.Sleep(60);
            }
            Thread.Sleep(Math.Max(10, settleMs));
        }

        public static void ScrollAt(int x, int y, int lines, bool horizontal, int settleMs)
        {
            MoveTo(x, y);
            Thread.Sleep(Math.Max(10, settleMs / 2));
            int notches = Math.Max(1, Math.Min(Math.Abs(lines), 40));
            int delta = (lines < 0 ? -1 : 1) * 120;
            for (int i = 0; i < notches; i++)
            {
                Native.mouse_event(horizontal ? Native.MOUSEEVENTF_HWHEEL : Native.MOUSEEVENTF_WHEEL, 0, 0, delta, UIntPtr.Zero);
                Thread.Sleep(30);
            }
            Thread.Sleep(Math.Max(10, settleMs));
        }

        public static void Drag(int fromX, int fromY, int toX, int toY, string button, int durationMs, int settleMs)
        {
            MoveTo(fromX, fromY);
            Thread.Sleep(Math.Max(20, settleMs / 2));
            bool right = string.Equals(button, "right", StringComparison.OrdinalIgnoreCase);
            uint down = right ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN;
            uint up = right ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP;
            Native.mouse_event(down, 0, 0, 0, UIntPtr.Zero);
            int steps = Math.Max(8, Math.Min(60, durationMs / 16));
            for (int i = 1; i <= steps; i++)
            {
                double t = (double)i / steps;
                Native.SetCursorPos((int)Math.Round(fromX + (toX - fromX) * t), (int)Math.Round(fromY + (toY - fromY) * t));
                Thread.Sleep(Math.Max(4, durationMs / (steps * 2)));
            }
            Thread.Sleep(40);
            Native.mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(Math.Max(10, settleMs));
        }
    }

    #endregion

    #region tree reading

    /// <summary>
    /// Budget for pattern probing during one tree walk.
    ///
    /// Pattern information is the most useful part of a snapshot and the most
    /// expensive part on some providers: an Electron/Chromium window can spend
    /// hundreds of milliseconds on the first pattern probe for one element, while
    /// native windows answer in microseconds. In `auto` mode the plan probes until
    /// the time budget runs out, counts what it skipped, and reports that to the
    /// caller instead of silently taking twenty seconds.
    /// </summary>
    internal sealed class ProbePlan
    {
        /** `auto` (budgeted), `all` (every element), `none` (skip probing). */
        public string Mode = "auto";
        public int BudgetMs = 2000;
        public long Deadline;
        public bool Started;
        public int MaxProbes = 8000;
        public int Probed;
        public int Skipped;

        /// <summary>
        /// Start the probing clock, if it has not started yet.
        ///
        /// The clock is started lazily by the first probe rather than when the
        /// request is parsed: a cold provider (UWP and Electron apps can take
        /// seconds to answer their first call) would otherwise consume the whole
        /// budget during the scan and leave nothing for probing. With a lazy start
        /// the budget always measures probing work only.
        /// </summary>
        public void StartBudget()
        {
            if (Started) return;
            Started = true;
            Deadline = Environment.TickCount + BudgetMs;
        }

        public static ProbePlan From(D options)
        {
            ProbePlan plan = new ProbePlan();
            if (A.Has(options, "patterns"))
            {
                object raw = options["patterns"];
                if (raw is bool) plan.Mode = (bool)raw ? "all" : "none";
                else
                {
                    string text = raw as string;
                    if (text != null)
                    {
                        text = text.Trim().ToLowerInvariant();
                        if (text == "all" || text == "true") plan.Mode = "all";
                        else if (text == "none" || text == "false") plan.Mode = "none";
                        else plan.Mode = "auto";
                    }
                }
            }
            int budgetMs = A.Int(options, "patternBudgetMs", 2000);
            if (budgetMs < 0) budgetMs = 0;
            if (budgetMs > 60000) budgetMs = 60000;
            plan.BudgetMs = budgetMs;
            return plan;
        }

        /// <summary>Whether the next element may be probed; counts both outcomes.</summary>
        public bool ShouldProbe()
        {
            if (Mode == "none") return false;
            if (Mode == "all")
            {
                Probed++;
                return true;
            }
            StartBudget();
            if (Probed >= MaxProbes || Environment.TickCount > Deadline)
            {
                Skipped++;
                return false;
            }
            Probed++;
            return true;
        }

        public bool Incomplete
        {
            get { return Skipped > 0; }
        }
    }

    internal static class Tree
    {
        public sealed class Node
        {
            public AutomationElement Element;
            public string Id;
            public D Record;
            public int Depth;
            public bool Control;
            public bool Content;
            public bool Offscreen;
            public bool Exists = true;
            public List<Node> Children = new List<Node>();
        }

        private static CacheRequest BuildCache()
        {
            CacheRequest request = new CacheRequest();
            request.Add(AutomationElement.NameProperty);
            request.Add(AutomationElement.AutomationIdProperty);
            request.Add(AutomationElement.ClassNameProperty);
            request.Add(AutomationElement.ControlTypeProperty);
            request.Add(AutomationElement.BoundingRectangleProperty);
            request.Add(AutomationElement.IsEnabledProperty);
            request.Add(AutomationElement.IsOffscreenProperty);
            request.Add(AutomationElement.HasKeyboardFocusProperty);
            request.Add(AutomationElement.NativeWindowHandleProperty);
            request.Add(AutomationElement.IsControlElementProperty);
            request.Add(AutomationElement.IsContentElementProperty);
            request.Add(AutomationElement.ProcessIdProperty);
            request.Add(AutomationElement.RuntimeIdProperty);
            // Pattern availability is deliberately NOT cached: measured on an
            // Electron/Chromium window, asking a provider for the availability
            // properties inside a cache request costs about a second per element,
            // while probing the patterns directly afterwards costs milliseconds.
            // Probing therefore runs under a caller-visible budget (see ProbePlan).
            //
            // Only Element, Children and Descendants are accepted here: adding
            // TreeScope.Parent makes the whole request throw, which silently pushed
            // every read onto the explicit-walk fallback. Nesting is therefore
            // resolved with a TreeWalker instead.
            //
            // The cache scope must be Subtree, not Descendants: with Descendants the
            // collection arrives but every Cached read throws, while Subtree caches
            // the whole subtree as intended. Verified against a live window: Subtree
            // gave 17/17 readable cached properties, Descendants 0/17.
            request.TreeScope = TreeScope.Subtree;
            request.TreeFilter = Condition.TrueCondition;
            return request;
        }

        /// <summary>
        /// Visit every descendant of one element while a cache request is active,
        /// so property reads for the whole subtree cost one cross-process round trip.
        /// @returns true when the cached scan ran; false when the caller must walk.
        /// </summary>
        private static bool VisitDescendants(AutomationElement root, Action<AutomationElement> visit, out string error)
        {
            error = null;
            CacheRequest cache = BuildCache();
            try
            {
                using (cache.Activate())
                {
                    AutomationElementCollection all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                    for (int i = 0; i < all.Count; i++) visit(all[i]);
                }
                return true;
            }
            catch (Exception ex)
            {
                error = Win.MessageOf(ex, 0);
                return false;
            }
        }

        private static string Name(AutomationElement el, bool cached)
        {
            try { return cached ? el.Cached.Name : el.Current.Name; }
            catch { return null; }
        }

        private static string AutomationId(AutomationElement el, bool cached)
        {
            try { return cached ? el.Cached.AutomationId : el.Current.AutomationId; }
            catch { return null; }
        }

        private static string ClassName(AutomationElement el, bool cached)
        {
            try { return cached ? el.Cached.ClassName : el.Current.ClassName; }
            catch { return null; }
        }

        private static string TypeName(AutomationElement el, bool cached)
        {
            try { return cached ? Win.ShortType(el.Cached.ControlType) : Win.ShortType(el.Current.ControlType); }
            catch { return null; }
        }

        private static bool Flag(AutomationElement el, bool cached, int which)
        {
            try
            {
                AutomationElement.AutomationElementInformation info = cached ? el.Cached : el.Current;
                switch (which)
                {
                    case 0: return info.IsEnabled;
                    case 1: return info.IsOffscreen;
                    case 2: return info.HasKeyboardFocus;
                    case 3: return info.IsControlElement;
                    default: return info.IsContentElement;
                }
            }
            catch { return false; }
        }

        private static D RectOf(AutomationElement el, bool cached)
        {
            System.Windows.Rect box;
            try { box = cached ? el.Cached.BoundingRectangle : el.Current.BoundingRectangle; }
            catch { return null; }
            if (box.IsEmpty || box.Width <= 0 || box.Height <= 0) return null;
            D rect = A.New();
            A.Put(rect, "x", (int)Math.Round(box.X));
            A.Put(rect, "y", (int)Math.Round(box.Y));
            A.Put(rect, "w", (int)Math.Round(box.Width));
            A.Put(rect, "h", (int)Math.Round(box.Height));
            return rect;
        }

        private static readonly AutomationPattern[] probePatterns = new AutomationPattern[]
        {
            InvokePattern.Pattern, ValuePattern.Pattern, SelectionItemPattern.Pattern, TogglePattern.Pattern,
            ExpandCollapsePattern.Pattern, ScrollPattern.Pattern, ScrollItemPattern.Pattern, TextPattern.Pattern,
            GridPattern.Pattern, WindowPattern.Pattern, TransformPattern.Pattern, RangeValuePattern.Pattern,
            SelectionPattern.Pattern
        };

        private static readonly string[] patternCodes = new string[]
        {
            "invoke", "value", "selectItem", "toggle", "expandCollapse", "scroll", "scrollItem", "text",
            "grid", "window", "transform", "rangeValue", "select"
        };

        /**
         * Pattern availability for one element, read with live probes.
         * A cheap call on native providers; on Electron/Chromium the first probe
         * for an element can cost hundreds of milliseconds, which is why every
         * tree walk runs under a ProbePlan budget.
         */
        public static List<object> PatternNames(AutomationElement el)
        {
            List<object> names = new List<object>();
            for (int i = 0; i < probePatterns.Length; i++)
            {
                object pattern;
                try
                {
                    if (el.TryGetCurrentPattern(probePatterns[i], out pattern) && pattern != null)
                        names.Add(patternCodes[i]);
                }
                catch { }
            }
            return names;
        }

        /** Pattern codes that mean "a user could act on this element". */
        private static readonly string[] interactiveCodes = new string[]
        {
            "invoke", "value", "selectItem", "toggle", "expandCollapse", "scrollItem"
        };

        /// <summary>Whether an element can be driven at all, within the probe budget.</summary>
        public static bool IsInteractive(AutomationElement el, ProbePlan plan)
        {
            if (plan == null || !plan.ShouldProbe()) return false;
            List<object> names = PatternNames(el);
            for (int i = 0; i < names.Count; i++)
            {
                string code = names[i] as string;
                for (int k = 0; k < interactiveCodes.Length; k++)
                {
                    if (code == interactiveCodes[k]) return true;
                }
            }
            return false;
        }

        public static bool Supports(AutomationElement el, AutomationPattern kind)
        {
            object pattern;
            try { return el.TryGetCurrentPattern(kind, out pattern) && pattern != null; }
            catch { return false; }
        }

        private static Node NewNode(AutomationElement el, bool cached)
        {
            if (el == null) return null;
            Node node = new Node();
            node.Element = el;
            D record = A.New();
            node.Id = Registry.Register(el);
            A.Put(record, "id", node.Id);

            string name = Name(el, cached);
            if (!string.IsNullOrEmpty(name)) A.Put(record, "name", name);
            string type = TypeName(el, cached);
            if (!string.IsNullOrEmpty(type)) A.Put(record, "type", type);
            string aid = AutomationId(el, cached);
            if (!string.IsNullOrEmpty(aid)) A.Put(record, "aid", aid);
            string cls = ClassName(el, cached);
            if (!string.IsNullOrEmpty(cls)) A.Put(record, "class", cls);

            node.Control = Flag(el, cached, 3);
            node.Content = Flag(el, cached, 4);
            node.Offscreen = Flag(el, cached, 1);
            if (node.Offscreen) A.Put(record, "offscreen", true);
            if (!Flag(el, cached, 0)) A.Put(record, "enabled", false);
            if (Flag(el, cached, 2)) A.Put(record, "focused", true);

            D rect = RectOf(el, cached);
            if (rect != null && !node.Offscreen) A.Put(record, "rect", rect);

            node.Record = record;
            return node;
        }

        /// <summary>Read one window subtree: nested tree, flat index, and truncation facts.</summary>
        public static Node Read(AutomationElement root, D options, ProbePlan plan, out List<Node> flat, out bool truncated)
        {
            int maxDepth = A.Int(options, "maxDepth", 6);
            if (maxDepth < 0) maxDepth = 0;
            if (maxDepth > 24) maxDepth = 24;
            int maxChildren = A.Int(options, "maxChildren", 60);
            if (maxChildren < 1) maxChildren = 1;
            if (maxChildren > 400) maxChildren = 400;
            int maxNodes = A.Int(options, "maxNodes", 800);
            if (maxNodes < 10) maxNodes = 10;
            if (maxNodes > 5000) maxNodes = 5000;
            string view = A.Str(options, "view", "control");
            bool includeOffscreen = A.Bool(options, "includeOffscreen", true);
            bool raw = view == "raw";

            flat = new List<Node>();
            truncated = false;

            Node rootNode = NewNode(root, false);
            if (rootNode == null)
            {
                rootNode = new Node();
                rootNode.Record = A.New();
            }
            rootNode.Depth = 0;

            List<AutomationElement> descendants = new List<AutomationElement>();
            Dictionary<string, Node> byRuntime = new Dictionary<string, Node>(StringComparer.Ordinal);
            Dictionary<string, AutomationElement> parentOf = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);

            string scanError;
            bool cacheWorked = VisitDescendants(root, delegate(AutomationElement el)
            {
                Node node = NewNode(el, true);
                if (node == null) return;
                descendants.Add(el);
                byRuntime[RuntimeKey(el)] = node;
                try
                {
                    AutomationElement parent = el.CachedParent;
                    if (parent != null) parentOf[node.Id] = parent;
                }
                catch { }
            }, out scanError);

            if (!cacheWorked)
            {
                descendants.Clear();
                byRuntime.Clear();
                parentOf.Clear();
                Walk(root, 0, 24, descendants);
                for (int i = 0; i < descendants.Count; i++)
                {
                    Node node = NewNode(descendants[i], false);
                    if (node == null) continue;
                    byRuntime[RuntimeKey(descendants[i])] = node;
                    AutomationElement parent = null;
                    try { parent = TreeWalker.ControlViewWalker.GetParent(descendants[i]); }
                    catch { }
                    if (parent != null) parentOf[node.Id] = parent;
                }
            }

            byRuntime["ROOT"] = rootNode;
            string rootKey = RuntimeKey(root);

            for (int i = 0; i < descendants.Count; i++)
            {
                Node node;
                if (!byRuntime.TryGetValue(RuntimeKey(descendants[i]), out node)) continue;
                Node ancestor = null;
                AutomationElement parentEl;
                if (!parentOf.TryGetValue(node.Id, out parentEl) || parentEl == null)
                {
                    // Providers that ignore Parent caching still nest correctly via an
                    // explicit walk, so the tree shape never depends on cache support.
                    try { parentEl = TreeWalker.ControlViewWalker.GetParent(descendants[i]); }
                    catch { parentEl = null; }
                }
                if (parentEl == null) ancestor = rootNode;
                else
                {
                    AutomationElement cursor = parentEl;
                    for (int hop = 0; hop < 64 && cursor != null; hop++)
                    {
                        string key = RuntimeKey(cursor);
                        if (key == rootKey) { ancestor = rootNode; break; }
                        Node found;
                        if (byRuntime.TryGetValue(key, out found)) { ancestor = found; break; }
                        try { cursor = TreeWalker.ControlViewWalker.GetParent(cursor); }
                        catch { cursor = null; }
                    }
                    if (ancestor == null) ancestor = rootNode;
                }
                ancestor.Children.Add(node);
            }

            if (!raw) FilterView(rootNode, view == "content");
            AssignDepth(rootNode, 0);

            int total = 0;
            Cap(rootNode, maxDepth, maxChildren, maxNodes, ref total, ref truncated);
            // Probing after the cap means only the elements the caller actually
            // receives are probed: on Chromium a raw subtree can hold hundreds of
            // elements that the view filter drops.
            plan.StartBudget();
            ProbePatterns(rootNode, plan);
            Collect(rootNode, flat, includeOffscreen);
            return rootNode;
        }

        /// <summary>
        /// Fill in supported patterns for the elements that survived filtering and
        /// capping, within the probe budget. Probing only what the caller receives
        /// keeps a Chromium window from paying for hundreds of dropped elements.
        /// </summary>
        private static void ProbePatterns(Node node, ProbePlan plan)
        {
            if (plan == null || node == null) return;
            if (node.Id != null && plan.ShouldProbe())
            {
                List<object> names = PatternNames(node.Element);
                if (names.Count > 0) A.Put(node.Record, "patterns", names);
            }
            for (int i = 0; i < node.Children.Count; i++) ProbePatterns(node.Children[i], plan);
        }

        private static void Walk(AutomationElement parent, int depth, int maxDepth, List<AutomationElement> sink)
        {
            if (depth >= maxDepth) return;
            AutomationElement child = null;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(parent); }
            catch { return; }
            int guard = 0;
            while (child != null && guard < 1000)
            {
                guard++;
                sink.Add(child);
                Walk(child, depth + 1, maxDepth, sink);
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); }
                catch { break; }
            }
        }

        private static string RuntimeKey(AutomationElement el)
        {
            try
            {
                int[] runtime = el.GetRuntimeId();
                if (runtime == null || runtime.Length == 0) return "anon:" + Guid.NewGuid().ToString("N");
                StringBuilder sb = new StringBuilder(48);
                for (int i = 0; i < runtime.Length; i++)
                {
                    if (i > 0) sb.Append('.');
                    sb.Append(runtime[i]);
                }
                return sb.ToString();
            }
            catch { return "anon:" + Guid.NewGuid().ToString("N"); }
        }

        /// <summary>Drop elements the requested view excludes, promoting their children.</summary>
        private static void FilterView(Node node, bool contentOnly)
        {
            List<Node> kept = new List<Node>();
            for (int i = 0; i < node.Children.Count; i++)
            {
                Node child = node.Children[i];
                FilterView(child, contentOnly);
                bool visible = contentOnly ? child.Content : child.Control;
                if (visible) kept.Add(child);
                else kept.AddRange(child.Children);
            }
            node.Children = kept;
        }

        private static void AssignDepth(Node node, int depth)
        {
            node.Depth = depth;
            for (int i = 0; i < node.Children.Count; i++) AssignDepth(node.Children[i], depth + 1);
        }

        private static void Cap(Node node, int maxDepth, int maxChildren, int maxNodes, ref int total, ref bool truncated)
        {
            if (node.Children.Count > maxChildren)
            {
                truncated = true;
                A.Put(node.Record, "hiddenChildren", node.Children.Count - maxChildren);
                node.Children.RemoveRange(maxChildren, node.Children.Count - maxChildren);
            }
            total++;
            if (node.Depth >= maxDepth && node.Children.Count > 0)
            {
                truncated = true;
                A.Put(node.Record, "childCount", node.Children.Count);
                node.Children.Clear();
                A.Put(node.Record, "collapsed", "maxDepth");
                return;
            }
            List<Node> survivors = new List<Node>();
            for (int i = 0; i < node.Children.Count; i++)
            {
                if (total >= maxNodes)
                {
                    truncated = true;
                    A.Put(node.Record, "collapsed", "maxNodes");
                    break;
                }
                Cap(node.Children[i], maxDepth, maxChildren, maxNodes, ref total, ref truncated);
                survivors.Add(node.Children[i]);
            }
            node.Children = survivors;
        }

        private static void Collect(Node node, List<Node> flat, bool includeOffscreen)
        {
            if (node.Id != null && (includeOffscreen || !node.Offscreen)) flat.Add(node);
            for (int i = 0; i < node.Children.Count; i++) Collect(node.Children[i], flat, includeOffscreen);
        }

        public static D Serialize(Node node)
        {
            D output = A.New();
            if (node.Record != null)
            {
                foreach (KeyValuePair<string, object> entry in node.Record) output[entry.Key] = entry.Value;
            }
            if (node.Children.Count > 0)
            {
                List<object> children = new List<object>();
                for (int i = 0; i < node.Children.Count; i++) children.Add(Serialize(node.Children[i]));
                A.Put(output, "children", children);
            }
            return output;
        }

        public static D DescribeRoot(AutomationElement root)
        {
            D info = A.New();
            try
            {
                A.Put(info, "name", root.Current.Name);
                A.Put(info, "type", Win.ShortType(root.Current.ControlType));
                A.Put(info, "class", root.Current.ClassName);
                int pid = root.Current.ProcessId;
                A.Put(info, "pid", pid);
                A.Put(info, "process", Win.ProcessNameOf(pid));
                int handle = root.Current.NativeWindowHandle;
                if (handle == 0)
                {
                    // Some providers expose the window element without a handle; walk
                    // up so the record still carries hwnd, title and rectangle.
                    IntPtr owner = Win.HwndOf(root);
                    if (owner != IntPtr.Zero) handle = owner.ToInt32();
                }
                if (handle != 0)
                {
                    IntPtr h = new IntPtr(handle);
                    A.Put(info, "hwnd", "0x" + h.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                    // A UIA name is often empty while the Win32 title is not (terminals,
                    // canvas apps, some Electron windows). Both belong in the record.
                    string winTitle = Native.TitleOf(h);
                    if (!string.IsNullOrEmpty(winTitle)) A.Put(info, "title", winTitle);
                    RECT r;
                    if (Native.GetWindowRect(h, out r))
                    {
                        D rect = A.New();
                        A.Put(rect, "x", r.Left);
                        A.Put(rect, "y", r.Top);
                        A.Put(rect, "w", r.Right - r.Left);
                        A.Put(rect, "h", r.Bottom - r.Top);
                        A.Put(info, "rect", rect);
                    }
                }
                A.Put(info, "elementId", Registry.Register(root));
            }
            catch (Exception ex) { A.Put(info, "readError", Win.MessageOf(ex, 0)); }
            return info;
        }

        /// <summary>
        /// Find elements by name/type/automation id across a whole subtree.
        ///
        /// Filtering and node building happen inside the activated cache request:
        /// cached properties are only readable while the request that filled them
        /// is active, so reading them afterwards silently yields empty values and
        /// a query that matches nothing.
        /// </summary>
        public static List<Node> Query(AutomationElement window, D query, int limit, ProbePlan plan, out bool scannedOk, out string scanError)
        {
            scannedOk = true;
            scanError = null;
            List<Node> matches = new List<Node>();
            string name = A.Str(query, "name", null);
            string type = A.Str(query, "type", null);
            string aid = A.Str(query, "aid", null);
            bool interactiveOnly = A.Bool(query, "interactiveOnly", false);
            bool enabledOnly = A.Bool(query, "enabledOnly", false);
            bool exact = A.Bool(query, "exact", false);
            if (limit <= 0) limit = 20;

            bool cacheWorked = VisitDescendants(window, delegate(AutomationElement el)
            {
                if (matches.Count >= limit) return;
                if (name != null && !Match(Name(el, true), name, exact)) return;
                if (type != null && !Match(TypeName(el, true), type, true)) return;
                if (aid != null && !Match(AutomationId(el, true), aid, true)) return;
                if (enabledOnly && !Flag(el, true, 0)) return;
                if (interactiveOnly && !IsInteractive(el, plan)) return;
                Node node = NewNode(el, true);
                if (node == null) return;
                if (plan.ShouldProbe())
                {
                    List<object> names = PatternNames(el);
                    if (names.Count > 0) A.Put(node.Record, "patterns", names);
                }
                matches.Add(node);
            }, out scanError);

            if (!cacheWorked) scannedOk = false;
            return matches;
        }

        private static bool Match(string value, string want, bool exact)
        {
            if (value == null) value = "";
            if (exact) return string.Equals(value, want, StringComparison.OrdinalIgnoreCase);
            return value.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>Readable ancestry of one element: what a human would use to describe where it lives.</summary>
        public static string PathOf(AutomationElement el)
        {
            List<string> parts = new List<string>();
            try
            {
                AutomationElement cursor = TreeWalker.ControlViewWalker.GetParent(el);
                int guard = 0;
                while (cursor != null && guard < 12)
                {
                    guard++;
                    try
                    {
                        string type = Win.ShortType(cursor.Current.ControlType);
                        string name = cursor.Current.Name;
                        if (!string.IsNullOrEmpty(name)) parts.Insert(0, type + " \"" + A.Clip(name, 32) + "\"");
                        else if (type == "Window" || type == "Pane" || type == "Group" || type == "Document") parts.Insert(0, type);
                    }
                    catch { }
                    try { cursor = TreeWalker.ControlViewWalker.GetParent(cursor); }
                    catch { cursor = null; }
                }
            }
            catch { }
            return string.Join(" > ", parts.ToArray());
        }
    }

    #endregion

    #region operations

    internal static class Ops
    {
        private static int Settle(D p)
        {
            return Math.Max(0, Math.Min(3000, A.Int(p, "settleMs", 120)));
        }

        private static long Elapsed(long started)
        {
            return (long)((Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency);
        }

        public static object Ping(D p)
        {
            D result = A.New();
            A.Put(result, "ok", true);
            A.Put(result, "name", "UiaSidecar");
            A.Put(result, "engine", "Windows UI Automation (.NET Framework)");
            A.Put(result, "os", Environment.OSVersion.VersionString);
            A.Put(result, "clr", Environment.Version.ToString());
            A.Put(result, "processId", Process.GetCurrentProcess().Id);
            A.Put(result, "elevated", IsElevated());
            A.Put(result, "dpiAware", Dpi.Mode);
            A.Put(result, "monitors", Native.GetSystemMetrics(Native.SM_CMONITORS));
            D screen = A.New();
            A.Put(screen, "x", Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN));
            A.Put(screen, "y", Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN));
            A.Put(screen, "w", Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN));
            A.Put(screen, "h", Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
            A.Put(result, "virtualScreen", screen);
            A.Put(result, "cachedElements", Registry.Count);
            A.Put(result, "methods", new List<object>(new object[]
            {
                "ping", "list_windows", "snapshot", "inspect", "act", "type", "key", "wait", "launch", "clipboard", "screenshot", "window"
            }));
            return result;
        }

        private static bool IsElevated()
        {
            try
            {
                System.Security.Principal.WindowsIdentity identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                System.Security.Principal.WindowsPrincipal principal = new System.Security.Principal.WindowsPrincipal(identity);
                return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        public static object ListWindows(D p)
        {
            bool includeUntitled = A.Bool(p, "includeUntitled", false);
            int limit = A.Int(p, "limit", 50);
            if (limit < 1) limit = 50;
            if (limit > 400) limit = 400;
            string titleFilter = A.Str(p, "title", null);
            int pidFilter = A.Int(p, "pid", 0);

            List<IntPtr> windows = Win.Enumerate(includeUntitled);
            List<object> list = new List<object>();
            int matched = 0;
            for (int i = 0; i < windows.Count; i++)
            {
                IntPtr h = windows[i];
                if (pidFilter != 0)
                {
                    uint pid;
                    Native.GetWindowThreadProcessId(h, out pid);
                    if ((int)pid != pidFilter) continue;
                }
                if (titleFilter != null && Native.TitleOf(h).IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                matched++;
                if (list.Count < limit) list.Add(Win.Describe(h, false));
            }
            D result = A.New();
            A.Put(result, "windows", list);
            A.Put(result, "count", list.Count);
            A.Put(result, "matchedTotal", matched);
            A.Put(result, "foreground", Win.Describe(Native.GetForegroundWindow(), false));
            return result;
        }

        public static object Snapshot(D p)
        {
            D info;
            IntPtr hwnd = Win.Resolve(p, out info);
            AutomationElement window = AutomationElement.FromHandle(hwnd);
            if (window == null)
                throw new Fail("WINDOW_NOT_READABLE", "could not attach UI Automation to that window",
                    "The window may have closed; call desktop_windows again.");

            long started = Stopwatch.GetTimestamp();
            D query = A.Dict(p, "query");
            if (query != null)
            {
                int limit = A.Int(p, "limit", 20);
                if (limit < 1) limit = 20;
                if (limit > 200) limit = 200;
                ProbePlan queryPlan = ProbePlan.From(p);
                bool scannedOk;
                string scanError;
                List<Tree.Node> matches = Tree.Query(window, query, limit, queryPlan, out scannedOk, out scanError);
                List<object> items = new List<object>();
                for (int i = 0; i < matches.Count; i++)
                {
                    D record = Tree.Serialize(matches[i]);
                    A.Put(record, "path", Tree.PathOf(matches[i].Element));
                    items.Add(record);
                }
                D qresult = A.New();
                A.Put(qresult, "window", info);
                A.Put(qresult, "matchCount", items.Count);
                A.Put(qresult, "matches", items);
                if (!scannedOk)
                {
                    A.Put(qresult, "scanComplete", false);
                    if (scanError != null) A.Put(qresult, "scanError", scanError);
                }
                if (queryPlan.Incomplete)
                {
                    A.Put(qresult, "patternsSkipped", queryPlan.Skipped);
                    A.Put(qresult, "patternsProbed", queryPlan.Probed);
                }
                A.Put(qresult, "elapsedMs", Elapsed(started));
                if (items.Count == 0)
                    A.Put(qresult, "hint", "No match. Call desktop_snapshot without query to see the tree, or relax the name/type filters.");
                return qresult;
            }

            List<Tree.Node> flat;
            bool truncated;
            ProbePlan plan = ProbePlan.From(p);
            Tree.Node rootNode = Tree.Read(window, p, plan, out flat, out truncated);

            D result = A.New();
            A.Put(result, "window", Tree.DescribeRoot(window));
            A.Put(result, "tree", Tree.Serialize(rootNode));
            A.Put(result, "nodes", flat.Count);
            if (plan.Incomplete)
            {
                A.Put(result, "patternsSkipped", plan.Skipped);
                A.Put(result, "patternsProbed", plan.Probed);
                A.Put(result, "patternsNote", "pattern info omitted for " + plan.Skipped.ToString(CultureInfo.InvariantCulture) + " elements after the time budget; use desktop_inspect for one element, or pass patterns:\"all\" for a complete but slower read");
            }
            if (truncated) A.Put(result, "truncated", true);
            A.Put(result, "elapsedMs", Elapsed(started));
            return result;
        }

        public static object Inspect(D p)
        {
            string id = A.Str(p, "id", null);
            AutomationElement el = Registry.Require(id, "inspect");

            D result = A.New();
            A.Put(result, "id", id);
            A.Put(result, "properties", Properties(el));
            A.Put(result, "patterns", Tree.PatternNames(el));

            D details = A.New();
            object raw;
            if (Tree.Supports(el, ValuePattern.Pattern))
            {
                try
                {
                    el.TryGetCurrentPattern(ValuePattern.Pattern, out raw);
                    ValuePattern vp = (ValuePattern)raw;
                    A.Put(details, "value", vp.Current.Value);
                    A.Put(details, "readOnly", vp.Current.IsReadOnly);
                }
                catch { }
            }
            if (Tree.Supports(el, TogglePattern.Pattern))
            {
                try
                {
                    el.TryGetCurrentPattern(TogglePattern.Pattern, out raw);
                    A.Put(details, "toggleState", ((TogglePattern)raw).Current.ToggleState.ToString());
                }
                catch { }
            }
            if (Tree.Supports(el, RangeValuePattern.Pattern))
            {
                try
                {
                    el.TryGetCurrentPattern(RangeValuePattern.Pattern, out raw);
                    RangeValuePattern rp = (RangeValuePattern)raw;
                    A.Put(details, "rangeValue", rp.Current.Value);
                    A.Put(details, "rangeMin", rp.Current.Minimum);
                    A.Put(details, "rangeMax", rp.Current.Maximum);
                }
                catch { }
            }
            if (Tree.Supports(el, ExpandCollapsePattern.Pattern))
            {
                try
                {
                    el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out raw);
                    A.Put(details, "expandState", ((ExpandCollapsePattern)raw).Current.ExpandCollapseState.ToString());
                }
                catch { }
            }
            string selection = SelectionText(el);
            if (selection != null) A.Put(details, "selection", selection);
            D grid = GridText(el);
            if (grid != null) A.Put(details, "grid", grid);
            if (Tree.Supports(el, TextPattern.Pattern))
            {
                try
                {
                    el.TryGetCurrentPattern(TextPattern.Pattern, out raw);
                    A.Put(details, "text", A.Clip(((TextPattern)raw).DocumentRange.GetText(2000), 2000));
                }
                catch { }
            }
            A.Put(result, "details", details);
            A.Put(result, "path", Tree.PathOf(el));

            IntPtr hwnd = Win.HwndOf(el);
            if (hwnd != IntPtr.Zero) A.Put(result, "window", Win.Describe(hwnd, false));
            return result;
        }

        private static D Properties(AutomationElement el)
        {
            D props = A.New();
            AutomationElement.AutomationElementInformation cur;
            try { cur = el.Current; }
            catch (ElementNotAvailableException)
            {
                throw new Fail("STALE_ELEMENT", "the element disappeared while it was being inspected",
                    "Run desktop_snapshot again; the window changed.");
            }
            A.Put(props, "name", cur.Name);
            A.Put(props, "type", Win.ShortType(cur.ControlType));
            A.Put(props, "automationId", cur.AutomationId);
            A.Put(props, "className", cur.ClassName);
            A.Put(props, "framework", cur.FrameworkId);
            A.Put(props, "processId", cur.ProcessId);
            A.Put(props, "enabled", cur.IsEnabled);
            A.Put(props, "offscreen", cur.IsOffscreen);
            A.Put(props, "focused", cur.HasKeyboardFocus);
            A.Put(props, "keyboardFocusable", cur.IsKeyboardFocusable);
            A.Put(props, "controlElement", cur.IsControlElement);
            A.Put(props, "contentElement", cur.IsContentElement);
            A.Put(props, "acceleratorKey", cur.AcceleratorKey);
            A.Put(props, "accessKey", cur.AccessKey);
            A.Put(props, "helpText", cur.HelpText);
            A.Put(props, "itemStatus", cur.ItemStatus);
            A.Put(props, "itemType", cur.ItemType);
            A.Put(props, "localizedType", cur.LocalizedControlType);
            System.Windows.Rect box = cur.BoundingRectangle;
            D rect = A.New();
            A.Put(rect, "x", (int)Math.Round(box.X));
            A.Put(rect, "y", (int)Math.Round(box.Y));
            A.Put(rect, "w", (int)Math.Round(box.Width));
            A.Put(rect, "h", (int)Math.Round(box.Height));
            A.Put(props, "rect", rect);
            return props;
        }

        private static string SelectionText(AutomationElement el)
        {
            object raw;
            if (!Tree.Supports(el, SelectionPattern.Pattern)) return null;
            try
            {
                el.TryGetCurrentPattern(SelectionPattern.Pattern, out raw);
                AutomationElement[] selected = ((SelectionPattern)raw).Current.GetSelection();
                if (selected == null || selected.Length == 0) return "";
                List<string> names = new List<string>();
                for (int i = 0; i < selected.Length && i < 40; i++)
                {
                    try { names.Add(selected[i].Current.Name); }
                    catch { }
                }
                return string.Join(" | ", names.ToArray());
            }
            catch { return null; }
        }

        private static D GridText(AutomationElement el)
        {
            object raw;
            if (!Tree.Supports(el, GridPattern.Pattern)) return null;
            try
            {
                el.TryGetCurrentPattern(GridPattern.Pattern, out raw);
                GridPattern gp = (GridPattern)raw;
                int rows = gp.Current.RowCount;
                int cols = gp.Current.ColumnCount;
                D grid = A.New();
                A.Put(grid, "rows", rows);
                A.Put(grid, "cols", cols);
                List<object> table = new List<object>();
                int rowLimit = Math.Min(rows, 40);
                int colLimit = Math.Min(cols, 12);
                for (int r = 0; r < rowLimit; r++)
                {
                    List<object> row = new List<object>();
                    for (int c = 0; c < colLimit; c++)
                    {
                        string cell = "";
                        try
                        {
                            AutomationElement item = gp.GetItem(r, c);
                            if (item != null) cell = item.Current.Name;
                        }
                        catch { }
                        row.Add(cell);
                    }
                    table.Add(row);
                }
                A.Put(grid, "rowsData", table);
                if (rows > rowLimit) A.Put(grid, "truncatedRows", rows - rowLimit);
                if (cols > colLimit) A.Put(grid, "truncatedCols", cols - colLimit);
                return grid;
            }
            catch { return null; }
        }

        public static object Act(D p)
        {
            string action = A.Str(p, "action", "click");
            int settle = Settle(p);
            string id = A.Str(p, "id", null);
            D point = A.Dict(p, "point");

            AutomationElement el = null;
            if (id != null) el = Registry.Require(id, action);
            else if (point == null)
                throw new Fail("BAD_ARG", "act needs either id or point",
                    "Get an id from desktop_snapshot, or pass point {x,y} in physical screen pixels.");

            D result = A.New();
            A.Put(result, "action", action);
            IntPtr hwnd = IntPtr.Zero;
            int x = 0;
            int y = 0;

            if (el != null)
            {
                A.Put(result, "id", id);
                D about = A.New();
                try
                {
                    A.Put(about, "name", el.Current.Name);
                    A.Put(about, "type", Win.ShortType(el.Current.ControlType));
                }
                catch { }
                A.Put(result, "element", about);
                hwnd = Win.HwndOf(el);
                if (hwnd != IntPtr.Zero) Win.Focus(hwnd);
            }
            else
            {
                x = A.Int(point, "x", 0);
                y = A.Int(point, "y", 0);
                hwnd = Native.WindowFromPoint(new POINT { X = x, Y = y });
                if (hwnd != IntPtr.Zero) hwnd = Native.GetAncestor(hwnd, Native.GA_ROOT);
                if (hwnd != IntPtr.Zero) Win.Focus(hwnd);
            }

            if (ActionNeedsPoint(action) && el != null && !TryPoint(el, out x, out y))
                throw new Fail("NO_POINT", "element " + id + " has no clickable point (offscreen, collapsed, or zero-sized)",
                    "Bring the window forward with desktop_windows {action:\"focus\"}, or scroll it into view with desktop_act {action:\"scrollIntoView\"}.");

            switch (action)
            {
                case "focus":
                    RequireElement(el, action);
                    try { el.SetFocus(); }
                    catch (Exception ex)
                    {
                        throw new Fail("ACTION_FAILED", "focus failed: " + Win.MessageOf(ex, 0),
                            "The element may not accept focus; click it instead.");
                    }
                    A.Put(result, "method", "SetFocus");
                    break;

                case "invoke":
                    RequireElement(el, action);
                    object invokeRaw;
                    if (!Tree.Supports(el, InvokePattern.Pattern))
                        throw new Fail("NO_PATTERN", "element does not support Invoke", "Use action \"click\" instead.");
                    el.TryGetCurrentPattern(InvokePattern.Pattern, out invokeRaw);
                    ((InvokePattern)invokeRaw).Invoke();
                    A.Put(result, "method", "InvokePattern");
                    break;

                case "click":
                case "doubleClick":
                    if (el != null && TryInvoke(el))
                    {
                        A.Put(result, "method", "InvokePattern");
                        break;
                    }
                    Input.Click(x, y, A.Str(p, "button", "left"), action == "doubleClick" ? 2 : A.Int(p, "clicks", 1), settle);
                    A.Put(result, "method", "mouse");
                    break;

                case "rightClick":
                    Input.Click(x, y, "right", 1, settle);
                    A.Put(result, "method", "mouse");
                    break;

                case "hover":
                    Input.MoveTo(x, y);
                    A.Put(result, "method", "mouse");
                    break;

                case "setValue":
                {
                    RequireElement(el, action);
                    string text = A.Str(p, "text", "");
                    object raw;
                    if (!Tree.Supports(el, ValuePattern.Pattern))
                        throw new Fail("NO_PATTERN", "element does not expose a Value pattern",
                            "Use desktop_input {id, text} to type into it instead.");
                    el.TryGetCurrentPattern(ValuePattern.Pattern, out raw);
                    ValuePattern vp = (ValuePattern)raw;
                    try
                    {
                        if (vp.Current.IsReadOnly)
                            throw new Fail("READ_ONLY", "the element's value is read-only",
                                "Type into it instead: desktop_input {id, text} after focusing it.");
                        vp.SetValue(text);
                    }
                    catch (Fail) { throw; }
                    catch (Exception ex)
                    {
                        throw new Fail("ACTION_FAILED", "SetValue was rejected: " + Win.MessageOf(ex, 0),
                            "Fall back to desktop_input {id, text} to type the text.");
                    }
                    A.Put(result, "method", "ValuePattern.SetValue");
                    break;
                }

                case "select":
                case "addToSelection":
                {
                    RequireElement(el, action);
                    object raw;
                    if (!Tree.Supports(el, SelectionItemPattern.Pattern))
                        throw new Fail("NO_PATTERN", "element is not selectable (no SelectionItem pattern)",
                            "Use action \"click\" or \"toggle\" instead.");
                    el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out raw);
                    SelectionItemPattern sp = (SelectionItemPattern)raw;
                    if (action == "select") sp.Select(); else sp.AddToSelection();
                    A.Put(result, "method", "SelectionItemPattern." + action);
                    break;
                }

                case "toggle":
                {
                    RequireElement(el, action);
                    object raw;
                    if (!Tree.Supports(el, TogglePattern.Pattern))
                        throw new Fail("NO_PATTERN", "element is not a toggle (no Toggle pattern)",
                            "Use action \"click\" instead.");
                    el.TryGetCurrentPattern(TogglePattern.Pattern, out raw);
                    ((TogglePattern)raw).Toggle();
                    A.Put(result, "method", "TogglePattern.Toggle");
                    break;
                }

                case "expand":
                case "collapse":
                {
                    RequireElement(el, action);
                    object raw;
                    if (!Tree.Supports(el, ExpandCollapsePattern.Pattern))
                        throw new Fail("NO_PATTERN", "element cannot expand or collapse",
                            "Use action \"click\" instead.");
                    el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out raw);
                    ExpandCollapsePattern ep = (ExpandCollapsePattern)raw;
                    if (action == "expand") ep.Expand(); else ep.Collapse();
                    A.Put(result, "method", "ExpandCollapsePattern." + action);
                    break;
                }

                case "scrollIntoView":
                {
                    RequireElement(el, action);
                    object raw;
                    if (!Tree.Supports(el, ScrollItemPattern.Pattern))
                        throw new Fail("NO_PATTERN", "element is not inside a scrollable container",
                            "Scroll the container with desktop_act {action:\"scroll\", id:<container>, lines:-3}.");
                    el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out raw);
                    ((ScrollItemPattern)raw).ScrollIntoView();
                    A.Put(result, "method", "ScrollItemPattern.ScrollIntoView");
                    break;
                }

                case "scroll":
                {
                    if (el != null && !TryPoint(el, out x, out y))
                        throw new Fail("NO_POINT", "element has no point to scroll at", "Pass an explicit point {x,y} instead.");
                    int lines = A.Int(p, "lines", 3);
                    bool horizontal = string.Equals(A.Str(p, "axis", "vertical"), "horizontal", StringComparison.OrdinalIgnoreCase);
                    Input.ScrollAt(x, y, lines, horizontal, settle);
                    A.Put(result, "method", "mousewheel");
                    A.Put(result, "lines", lines);
                    break;
                }

                case "drag":
                {
                    RequireElement(el, action);
                    int targetX;
                    int targetY;
                    D to = A.Dict(p, "to");
                    D toPoint = A.Dict(p, "toPoint");
                    if (to != null && A.Has(to, "id"))
                    {
                        AutomationElement target = Registry.Require(A.Str(to, "id", null), "drag target");
                        if (!TryPoint(target, out targetX, out targetY))
                            throw new Fail("NO_POINT", "drag target has no clickable point", "Focus the window first.");
                    }
                    else if (toPoint != null)
                    {
                        targetX = A.Int(toPoint, "x", 0);
                        targetY = A.Int(toPoint, "y", 0);
                    }
                    else throw new Fail("BAD_ARG", "drag needs to {id} or toPoint {x,y}", "Pass the drop target.");

                    if (!TryPoint(el, out x, out y))
                        throw new Fail("NO_POINT", "drag source has no clickable point", "Focus the window first.");
                    Input.Drag(x, y, targetX, targetY, A.Str(p, "button", "left"), A.Int(p, "durationMs", 500), settle);
                    A.Put(result, "method", "mouse-drag");
                    D dropped = A.New();
                    A.Put(dropped, "x", targetX);
                    A.Put(dropped, "y", targetY);
                    A.Put(result, "toPoint", dropped);
                    break;
                }

                default:
                    throw new Fail("BAD_ACTION", "unknown action \"" + action + "\"",
                        "Supported: click, rightClick, doubleClick, hover, focus, invoke, setValue, select, addToSelection, toggle, expand, collapse, scrollIntoView, scroll, drag.");
            }

            if (hwnd != IntPtr.Zero) A.Put(result, "window", Win.Describe(hwnd, false));
            A.Put(result, "ok", true);
            return result;
        }

        private static bool ActionNeedsPoint(string action)
        {
            return action == "click" || action == "rightClick" || action == "doubleClick" || action == "hover";
        }

        private static void RequireElement(AutomationElement el, string action)
        {
            if (el == null) throw new Fail("BAD_ARG", action + " needs an element id", "Get one from desktop_snapshot.");
        }

        private static bool TryInvoke(AutomationElement el)
        {
            if (el == null || !Tree.Supports(el, InvokePattern.Pattern)) return false;
            try
            {
                object raw;
                el.TryGetCurrentPattern(InvokePattern.Pattern, out raw);
                ((InvokePattern)raw).Invoke();
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool TryPoint(AutomationElement el, out int x, out int y)
        {
            x = 0;
            y = 0;
            if (el == null) return false;
            try
            {
                System.Windows.Point point;
                if (el.TryGetClickablePoint(out point))
                {
                    x = (int)Math.Round(point.X);
                    y = (int)Math.Round(point.Y);
                    return true;
                }
            }
            catch { }
            try
            {
                System.Windows.Rect box = el.Current.BoundingRectangle;
                if (box.IsEmpty || box.Width <= 0 || box.Height <= 0) return false;
                x = (int)Math.Round(box.X + box.Width / 2);
                y = (int)Math.Round(box.Y + box.Height / 2);
                return true;
            }
            catch { return false; }
        }

        public static object TypeText(D p)
        {
            string text = A.Str(p, "text", "");
            string id = A.Str(p, "id", null);
            string method = A.Str(p, "method", "auto");
            bool clearFirst = A.Bool(p, "clearFirst", false);
            bool submit = A.Bool(p, "submit", false);
            int settle = Settle(p);

            D result = A.New();
            A.Put(result, "ok", true);
            A.Put(result, "chars", text.Length);

            AutomationElement el = null;
            IntPtr hwnd = IntPtr.Zero;
            if (id != null)
            {
                el = Registry.Require(id, "type");
                hwnd = Win.HwndOf(el);
                if (hwnd != IntPtr.Zero) Win.Focus(hwnd);
                try { el.SetFocus(); }
                catch (Exception ex)
                {
                    throw new Fail("FOCUS_FAILED", "could not focus " + id + ": " + Win.MessageOf(ex, 0),
                        "Click the field first (desktop_act {id, action:\"click\"}), then type.");
                }
            }

            bool usedValuePattern = false;
            if (el != null && (method == "auto" || method == "value"))
            {
                if (Tree.Supports(el, ValuePattern.Pattern))
                {
                    try
                    {
                        object raw;
                        el.TryGetCurrentPattern(ValuePattern.Pattern, out raw);
                        ValuePattern vp = (ValuePattern)raw;
                        if (!vp.Current.IsReadOnly)
                        {
                            vp.SetValue(clearFirst ? text : vp.Current.Value + text);
                            usedValuePattern = true;
                            A.Put(result, "method", "ValuePattern");
                        }
                    }
                    catch { usedValuePattern = false; }
                }
                else if (method == "value")
                    throw new Fail("NO_PATTERN", "method \"value\" needs an element with a Value pattern",
                        "Use method \"keys\" to send keystrokes into a custom control.");
            }

            if (!usedValuePattern)
            {
                if (clearFirst)
                {
                    Input.PressCombo("ctrl+a", settle);
                    Input.PressCombo("delete", settle);
                }
                Input.TypeText(text, settle);
                A.Put(result, "method", "SendInput-unicode");
            }

            if (submit)
            {
                Input.PressCombo("enter", settle);
                A.Put(result, "submitted", true);
            }
            if (hwnd != IntPtr.Zero) A.Put(result, "window", Win.Describe(hwnd, false));
            return result;
        }

        public static object Key(D p)
        {
            string keys = A.Str(p, "keys", null);
            string id = A.Str(p, "id", null);
            int settle = Settle(p);

            if (id != null)
            {
                AutomationElement el = Registry.Require(id, "key");
                IntPtr hwnd = Win.HwndOf(el);
                if (hwnd != IntPtr.Zero) Win.Focus(hwnd);
                try { el.SetFocus(); }
                catch { }
            }
            else if (A.Has(p, "hwnd") || A.Has(p, "pid") || A.Has(p, "title"))
            {
                D info;
                Win.Focus(Win.Resolve(p, out info));
            }

            int pressed = Input.PressCombo(keys, settle);
            D result = A.New();
            A.Put(result, "ok", true);
            A.Put(result, "keys", keys);
            A.Put(result, "keysPressed", pressed);
            return result;
        }

        public static object Wait(D p)
        {
            string kind = A.Str(p, "until", "element");
            int timeoutMs = A.Int(p, "timeoutMs", 8000);
            if (timeoutMs < 100) timeoutMs = 100;
            if (timeoutMs > 120000) timeoutMs = 120000;
            int pollMs = A.Int(p, "pollMs", 250);
            if (pollMs < 50) pollMs = 50;

            long started = Stopwatch.GetTimestamp();
            int attempts = 0;
            string detail = null;
            bool satisfied = false;
            bool delay = kind == "delay" || kind == "idle";

            while (true)
            {
                attempts++;
                try
                {
                    satisfied = Check(kind, p, out detail);
                }
                catch (Fail ex)
                {
                    detail = ex.Message;
                    satisfied = false;
                }
                catch (Exception ex)
                {
                    detail = Win.MessageOf(ex, 0);
                    satisfied = false;
                }
                if (satisfied) break;
                long spent = Elapsed(started);
                if (spent >= timeoutMs) break;
                Thread.Sleep((int)Math.Min(pollMs, Math.Max(20, timeoutMs - spent)));
            }

            D result = A.New();
            A.Put(result, "ok", true);
            A.Put(result, "satisfied", satisfied);
            A.Put(result, "until", kind);
            A.Put(result, "attempts", attempts);
            A.Put(result, "waitedMs", Elapsed(started));
            if (!satisfied)
            {
                A.Put(result, "detail", detail == null ? "condition never became true" : detail);
                A.Put(result, "hint", "Timed out. Take a snapshot to see the current state instead of waiting longer.");
            }
            else if (delay)
            {
                A.Put(result, "waitedMs", Elapsed(started));
            }
            return result;
        }

        private static bool Check(string kind, D p, out string detail)
        {
            detail = null;
            if (kind == "window")
            {
                D info;
                try
                {
                    Win.Resolve(p, out info);
                    detail = "window found: " + Convert.ToString(info["title"], CultureInfo.InvariantCulture);
                    return true;
                }
                catch (Fail ex)
                {
                    detail = ex.Message;
                    return false;
                }
            }
            if (kind == "element")
            {
                D info;
                IntPtr hwnd = Win.Resolve(p, out info);
                D query = A.Dict(p, "query");
                if (query == null) throw new Fail("BAD_ARG", "until:\"element\" needs query {name/type}", "Pass query {name:\"...\"}.");
                ProbePlan waitPlan = ProbePlan.From(p);
                bool scannedOk;
                string scanError;
                List<Tree.Node> matches = Tree.Query(AutomationElement.FromHandle(hwnd), query, 1, waitPlan, out scannedOk, out scanError);
                if (matches.Count == 0) detail = "no element matches query yet";
                return matches.Count > 0;
            }
            if (kind == "value")
            {
                string id = A.Str(p, "id", null);
                AutomationElement el;
                if (!Registry.TryGet(id, out el))
                {
                    detail = "element " + (id == null ? "(missing)" : id) + " is not in the registry";
                    return false;
                }
                object raw;
                if (!Tree.Supports(el, ValuePattern.Pattern))
                {
                    detail = "element has no Value pattern";
                    return false;
                }
                el.TryGetCurrentPattern(ValuePattern.Pattern, out raw);
                string current = ((ValuePattern)raw).Current.Value;
                string expectEquals = A.Str(p, "equals", null);
                if (expectEquals != null) return string.Equals(current, expectEquals, StringComparison.Ordinal);
                string expectContains = A.Str(p, "contains", null);
                if (expectContains != null) return current != null && current.IndexOf(expectContains, StringComparison.Ordinal) >= 0;
                detail = "value is \"" + A.Clip(current, 60) + "\"";
                return false;
            }
            if (kind == "gone")
            {
                string id = A.Str(p, "id", null);
                AutomationElement el;
                if (!Registry.TryGet(id, out el)) return true;
                try { int pid = el.Current.ProcessId; }
                catch (ElementNotAvailableException) { Registry.Forget(id); return true; }
                detail = "element still present";
                return false;
            }
            if (kind == "delay" || kind == "idle")
            {
                int ms = A.Int(p, "ms", 800);
                if (ms < 0) ms = 0;
                Thread.Sleep(Math.Min(ms, 60000));
                return true;
            }
            throw new Fail("BAD_ARG", "unknown until \"" + kind + "\"", "Use until: window | element | value | gone | delay | idle.");
        }

        public static object Launch(D p)
        {
            string target = A.Str(p, "target", null);
            if (string.IsNullOrEmpty(target))
                throw new Fail("BAD_ARG", "launch needs a target",
                    "Pass an executable, document path, or URI (for example \"notepad\", \"ms-settings:\", \"C:/tmp/report.pdf\").");
            string args = A.Str(p, "args", null);
            string workdir = A.Str(p, "workdir", null);
            int waitMs = A.Int(p, "waitMs", 0);

            ProcessStartInfo info = new ProcessStartInfo();
            info.UseShellExecute = true;
            info.FileName = target;
            if (!string.IsNullOrEmpty(args)) info.Arguments = args;
            if (!string.IsNullOrEmpty(workdir)) info.WorkingDirectory = workdir;

            D result = A.New();
            long started = Stopwatch.GetTimestamp();
            try
            {
                using (Process proc = Process.Start(info))
                {
                    if (proc != null)
                    {
                        A.Put(result, "pid", proc.Id);
                        A.Put(result, "process", proc.ProcessName);
                        if (waitMs > 0)
                        {
                            bool exited = proc.WaitForExit(Math.Min(waitMs, 120000));
                            A.Put(result, "exited", exited);
                            if (exited) A.Put(result, "exitCode", proc.ExitCode);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                throw new Fail("LAUNCH_FAILED", "could not start \"" + target + "\": " + Win.MessageOf(ex, 0),
                    "Check the path or URI. Elevation is not transferable: to drive an elevated app, start DSH elevated too.");
            }
            A.Put(result, "ok", true);
            A.Put(result, "target", target);
            A.Put(result, "elapsedMs", Elapsed(started));
            A.Put(result, "hint", "Wait for its window with desktop_wait {until:\"window\", title:\"...\"} before snapshotting.");
            return result;
        }

        public static object Clipboard(D p)
        {
            string op = A.Str(p, "op", "get");
            if (op == "get")
            {
                string text = RunSta<string>(delegate { return ClipboardGet(); });
                D result = A.New();
                A.Put(result, "ok", true);
                A.Put(result, "text", text);
                A.Put(result, "length", text == null ? 0 : text.Length);
                return result;
            }
            if (op == "set")
            {
                string text = A.Str(p, "text", "");
                bool ok = RunSta<bool>(delegate { return ClipboardSet(text); });
                if (!ok) throw new Fail("CLIPBOARD_BUSY", "the clipboard is locked by another process", "Retry in a moment.");
                D result = A.New();
                A.Put(result, "ok", true);
                A.Put(result, "length", text.Length);
                return result;
            }
            throw new Fail("BAD_ARG", "clipboard op must be \"get\" or \"set\"", "Use op:\"get\" or op:\"set\".");
        }

        private static string ClipboardGet()
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    if (System.Windows.Forms.Clipboard.ContainsText()) return System.Windows.Forms.Clipboard.GetText();
                    return "";
                }
                catch { Thread.Sleep(60); }
            }
            return "";
        }

        private static bool ClipboardSet(string text)
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetDataObject(text, true, 4, 120);
                    return true;
                }
                catch { Thread.Sleep(80); }
            }
            return false;
        }

        public static object Screenshot(D p)
        {
            string id = A.Str(p, "id", null);
            string mode = A.Str(p, "mode", "window");
            int maxWidth = A.Int(p, "maxWidth", 1280);
            if (maxWidth < 200) maxWidth = 200;
            if (maxWidth > 4096) maxWidth = 4096;
            string path = A.Str(p, "path", null);
            bool fullContent = A.Bool(p, "fullContent", true);

            IntPtr hwnd = IntPtr.Zero;
            if (id != null)
            {
                AutomationElement el = Registry.Require(id, "screenshot");
                hwnd = Win.HwndOf(el);
                if (hwnd == IntPtr.Zero)
                    throw new Fail("NO_WINDOW", "that element is not inside a top-level window",
                        "Pass a window's element id, or target the window by title with desktop_windows first.");
            }
            else if (mode != "screen" && mode != "display")
            {
                D info;
                hwnd = Win.Resolve(p, out info);
            }

            if (string.IsNullOrEmpty(path))
            {
                string dir = Path.Combine(Path.GetTempPath(), "dsh-uia");
                Directory.CreateDirectory(dir);
                path = Path.Combine(dir, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture) + ".png");
            }
            else
            {
                // A caller-supplied path may point into a folder that does not exist
                // yet. Creating it here keeps GDI+ from failing with its opaque
                // "A generic error occurred in GDI+" message.
                try
                {
                    string parent = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent)) Directory.CreateDirectory(parent);
                }
                catch (Exception ex)
                {
                    throw new Fail("BAD_PATH",
                        "cannot create the folder for " + path + ": " + ex.Message,
                        "Pass a path inside an existing folder, or one this process may create.");
                }
            }

            string method;
            bool occluded = false;
            Bitmap image;
            if (hwnd == IntPtr.Zero)
            {
                image = CaptureScreen();
                method = "screen";
            }
            else
            {
                image = CaptureWindow(hwnd, fullContent, out method, out occluded);
            }

            int finalWidth = image.Width;
            int finalHeight = image.Height;
            int originalWidth = image.Width;
            int originalHeight = image.Height;
            if (image.Width > maxWidth)
            {
                finalHeight = Math.Max(1, (int)Math.Round(image.Height * ((double)maxWidth / image.Width)));
                finalWidth = maxWidth;
                Bitmap resized = new Bitmap(finalWidth, finalHeight, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(resized))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(image, 0, 0, finalWidth, finalHeight);
                }
                image.Dispose();
                image = resized;
            }

            try { image.Save(path, ImageFormat.Png); }
            finally { image.Dispose(); }

            FileInfo file = new FileInfo(path);
            D result = A.New();
            A.Put(result, "ok", true);
            A.Put(result, "path", path);
            A.Put(result, "width", finalWidth);
            A.Put(result, "height", finalHeight);
            A.Put(result, "originalWidth", originalWidth);
            A.Put(result, "originalHeight", originalHeight);
            A.Put(result, "bytes", file.Length);
            A.Put(result, "method", method);
            if (occluded) A.Put(result, "occluded", true);
            if (hwnd != IntPtr.Zero) A.Put(result, "window", Win.Describe(hwnd, false));
            return result;
        }

        private static Bitmap CaptureScreen()
        {
            int w = Math.Max(1, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN));
            int h = Math.Max(1, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
            int x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            Bitmap bitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            return bitmap;
        }

        private static Bitmap CaptureWindow(IntPtr hwnd, bool fullContent, out string method, out bool occluded)
        {
            occluded = false;
            method = "unknown";
            if (Native.IsIconic(hwnd))
                throw new Fail("WINDOW_MINIMIZED", "the window is minimized, so it has no pixels",
                    "Restore it first: desktop_windows {action:\"restore\", title:\"...\"}.");
            RECT rect;
            if (!Native.GetWindowRect(hwnd, out rect))
                throw new Fail("WINDOW_NOT_FOUND", "window handle is gone", "Call desktop_windows again.");
            int width = Math.Max(1, rect.Right - rect.Left);
            int height = Math.Max(1, rect.Bottom - rect.Top);

            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            bool printed = false;
            try
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    IntPtr hdc = g.GetHdc();
                    try { printed = Native.PrintWindow(hwnd, hdc, fullContent ? 2u : 0u); }
                    finally { g.ReleaseHdc(hdc); }
                }
            }
            catch { printed = false; }

            if (printed)
            {
                method = "PrintWindow";
                return bitmap;
            }

            if (Native.GetForegroundWindow() != hwnd)
            {
                bitmap.Dispose();
                occluded = true;
                throw new Fail("WINDOW_OCCLUDED", "the window could not be captured while another window covers it",
                    "Focus it first (desktop_windows {action:\"focus\"}), then capture again.");
            }
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            method = "screen-copy";
            return bitmap;
        }

        public static object WindowOp(D p)
        {
            string action = A.Str(p, "action", "list");
            if (action == "list") return ListWindows(p);

            D result = A.New();
            A.Put(result, "action", action);

            if (action == "at")
            {
                // Resolve the window under a screen point: the host uses this to
                // attribute a coordinate action to an application before asking
                // for approval.
                D point = A.Dict(p, "point");
                if (point == null) throw new Fail("BAD_ARG", "window action \"at\" needs point {x,y}", "Pass point {x,y} in physical screen pixels.");
                IntPtr hit = Native.WindowFromPoint(new POINT { X = A.Int(point, "x", 0), Y = A.Int(point, "y", 0) });
                if (hit != IntPtr.Zero) hit = Native.GetAncestor(hit, Native.GA_ROOT);
                if (hit == IntPtr.Zero) throw new Fail("WINDOW_NOT_FOUND", "no window at that point", "The point may be outside every monitor.");
                A.Put(result, "window", Win.Describe(hit, true));
                A.Put(result, "ok", true);
                return result;
            }

            if (action == "info")
            {
                // Describe a window without touching it. With `id` the window is
                // found from an element the host already snapshotted; otherwise the
                // selector (or the foreground window) decides.
                if (A.Has(p, "id"))
                {
                    AutomationElement el = Registry.Require(A.Str(p, "id", null), "window lookup");
                    IntPtr owner = Win.HwndOf(el);
                    if (owner == IntPtr.Zero)
                        throw new Fail("NO_WINDOW", "that element is not inside a top-level window",
                            "Snapshots of a whole window include a window element; use one of those ids.");
                    A.Put(result, "window", Win.Describe(owner, true));
                    A.Put(result, "ok", true);
                    return result;
                }
                D probe;
                Win.Resolve(p, out probe);
                A.Put(result, "window", probe);
                A.Put(result, "ok", true);
                return result;
            }

            D info;
            IntPtr hwnd = Win.Resolve(p, out info);
            A.Put(result, "window", info);

            switch (action)
            {
                case "focus":
                {
                    bool ok = Win.Focus(hwnd);
                    A.Put(result, "focused", ok);
                    if (!ok) A.Put(result, "hint", "Windows may refuse a programmatic foreground change; clicks still target the window.");
                    break;
                }
                case "minimize": Native.ShowWindow(hwnd, Native.SW_MINIMIZE); break;
                case "maximize": Native.ShowWindow(hwnd, Native.SW_MAXIMIZE); break;
                case "restore": Native.ShowWindow(hwnd, Native.SW_RESTORE); break;
                case "show": Native.ShowWindow(hwnd, Native.SW_SHOW); break;
                case "hide": Native.ShowWindow(hwnd, Native.SW_HIDE); break;
                case "move":
                case "resize":
                {
                    RECT current;
                    if (!Native.GetWindowRect(hwnd, out current))
                        throw new Fail("WINDOW_NOT_FOUND", "window handle is gone", "Call desktop_windows again.");
                    int x = A.Int(p, "x", current.Left);
                    int y = A.Int(p, "y", current.Top);
                    int w = A.Int(p, "w", current.Right - current.Left);
                    int h = A.Int(p, "h", current.Bottom - current.Top);
                    Native.MoveWindow(hwnd, x, y, Math.Max(80, w), Math.Max(60, h), true);
                    break;
                }
                case "alwaysOnTop":
                    Native.SetWindowPos(hwnd, new IntPtr(Native.HWND_TOPMOST), 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_SHOWWINDOW);
                    break;
                case "notOnTop":
                    Native.SetWindowPos(hwnd, new IntPtr(Native.HWND_NOTOPMOST), 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_SHOWWINDOW);
                    break;
                case "close":
                {
                    AutomationElement el = AutomationElement.FromHandle(hwnd);
                    object raw;
                    if (el != null && Tree.Supports(el, WindowPattern.Pattern))
                    {
                        el.TryGetCurrentPattern(WindowPattern.Pattern, out raw);
                        ((WindowPattern)raw).Close();
                        A.Put(result, "method", "WindowPattern.Close");
                    }
                    else
                    {
                        Native.PostMessage(hwnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                        A.Put(result, "method", "WM_CLOSE");
                    }
                    break;
                }
                default:
                    throw new Fail("BAD_ACTION", "unknown window action \"" + action + "\"",
                        "Supported: list, focus, minimize, maximize, restore, show, hide, move, resize, alwaysOnTop, notOnTop, close.");
            }

            Thread.Sleep(120);
            RECT after;
            if (Native.GetWindowRect(hwnd, out after))
            {
                D rect = A.New();
                A.Put(rect, "x", after.Left);
                A.Put(rect, "y", after.Top);
                A.Put(rect, "w", after.Right - after.Left);
                A.Put(rect, "h", after.Bottom - after.Top);
                A.Put(result, "rect", rect);
            }
            A.Put(result, "ok", true);
            return result;
        }

        public static T RunSta<T>(Func<T> work)
        {
            T value = default(T);
            Exception failure = null;
            Thread thread = new Thread(delegate()
            {
                try { value = work(); }
                catch (Exception ex) { failure = ex; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            if (!thread.Join(15000))
                throw new Fail("TIMEOUT", "the operation did not finish within 15s", "The target may be busy; retry.");
            if (failure != null) throw failure;
            return value;
        }
    }

    internal static class Dpi
    {
        public static string Mode = "unknown";

        public static void Enable()
        {
            // The manifest already declares PerMonitorV2, so these calls normally
            // fail with access-denied; they exist for images built without the
            // manifest. Read the effective mode back instead of trusting the call.
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch { }
            try { Native.SetProcessDpiAwareness(2); }
            catch { }
            Mode = Describe();
            if (Mode == "unaware")
            {
                try { Native.SetProcessDPIAware(); }
                catch { }
                Mode = Describe();
            }
        }

        private static string Describe()
        {
            try
            {
                int value;
                if (Native.GetProcessDpiAwareness(IntPtr.Zero, out value) == 0)
                {
                    if (value == 2) return "per-monitor";
                    if (value == 1) return "system";
                    return "unaware";
                }
            }
            catch { }
            return "unknown";
        }
    }

    #endregion
}
