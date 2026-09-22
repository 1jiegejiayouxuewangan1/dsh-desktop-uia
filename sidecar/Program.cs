// DshUia protocol host: line-delimited JSON-RPC over stdin/stdout.
//
// One request per line:  {"id":1,"method":"snapshot","params":{...}}
// One response per line: {"id":1,"ok":true,"result":{...}}
//                        {"id":1,"ok":false,"error":{"code":"...","message":"...","hint":"..."}}
//
// stdout carries protocol traffic and nothing else; every diagnostic goes to
// stderr, because a stray stdout write would corrupt the stream for the host.
// Each request runs on its own thread behind a watchdog, so one hung UI
// Automation call cannot wedge the sidecar: the watchdog answers with a
// TIMEOUT error and, after too many consecutive hangs, exits so the host can
// start a fresh process.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

using D = System.Collections.Generic.Dictionary<string, object>;

namespace DshUia
{
    internal static class Program
    {
        private const string Version = "1.0.0";
        private const int DefaultTimeoutMs = 30000;
        private const int MaxConsecutiveTimeouts = 5;

        private static readonly object writeGate = new object();
        private static StreamWriter output;
        private static JavaScriptSerializer json;
        private static int consecutiveTimeouts;
        private static long handled;
        private static long failed;

        [STAThread]
        private static int Main(string[] args)
        {
            Dpi.Enable();

            json = new JavaScriptSerializer();
            json.MaxJsonLength = int.MaxValue;
            json.RecursionLimit = 200;

            if (args != null && args.Length > 0 && string.Equals(args[0], "--selftest", StringComparison.OrdinalIgnoreCase))
                return SelfTest();

            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 65536);
            output.AutoFlush = true;

            Stream stdin = Console.OpenStandardInput();
            StreamReader reader = new StreamReader(stdin, new UTF8Encoding(false), false, 65536);

            Emit("ready", ReadyPayload());

            string line;
            while (true)
            {
                try { line = reader.ReadLine(); }
                catch (Exception ex) { Log("stdin read failed: " + ex.Message); break; }
                if (line == null) break;
                string trimmed = line.Trim();
                if (trimmed.Length == 0) continue;
                if (!HandleLine(trimmed)) break;
            }
            return 0;
        }

        private static D ReadyPayload()
        {
            D payload = A.New();
            A.Put(payload, "version", Version);
            A.Put(payload, "dpiAware", Dpi.Mode);
            A.Put(payload, "pid", System.Diagnostics.Process.GetCurrentProcess().Id);
            return payload;
        }

        /// <summary>Parse and dispatch one protocol line. Returns false when the host asked to stop.</summary>
        private static bool HandleLine(string line)
        {
            object id = null;
            string method = null;
            D prms = null;

            try
            {
                object parsed = json.DeserializeObject(line);
                D envelope = parsed as D;
                if (envelope == null)
                {
                    RespondError(null, "BAD_REQUEST", "each request line must be a JSON object", "Send {\"id\":1,\"method\":\"ping\"}.");
                    return true;
                }
                if (envelope.ContainsKey("id")) id = envelope["id"];
                method = A.Str(envelope, "method", null);
                prms = A.Dict(envelope, "params");
                if (prms == null) prms = A.New();
                if (string.IsNullOrEmpty(method))
                {
                    RespondError(id, "BAD_REQUEST", "request has no method", "Add \"method\":\"ping\".");
                    return true;
                }
            }
            catch (Exception ex)
            {
                RespondError(null, "BAD_JSON", "could not parse the request line: " + ex.Message,
                    "Each line must be one complete JSON object with no embedded newlines.");
                return true;
            }

            if (method == "shutdown" || method == "exit")
            {
                Respond(id, ResultOk());
                return false;
            }

            int timeoutMs = TimeoutFor(method, prms, line);
            string capturedMethod = method;
            D capturedParams = prms;
            object capturedId = id;
            Thread worker = new Thread(delegate()
            {
                try
                {
                    object result = Dispatch(capturedMethod, capturedParams);
                    Respond(capturedId, result);
                }
                catch (Fail ex)
                {
                    RespondError(capturedId, ex.Code, ex.Message, ex.Hint);
                }
                catch (Exception ex)
                {
                    RespondError(capturedId, "INTERNAL", ex.GetType().Name + ": " + ex.Message,
                        "This is a sidecar defect; report it with the method name and arguments.");
                }
            });
            worker.IsBackground = true;
            worker.Name = "uia-" + capturedMethod;
            worker.Start();

            if (!worker.Join(timeoutMs))
            {
                RespondError(capturedId, "TIMEOUT",
                    "the " + capturedMethod + " call did not finish within " + timeoutMs.ToString(CultureInfo.InvariantCulture) + "ms",
                    "The target application is not responding to UI Automation. Wait for it, then retry; the sidecar stays usable.");
                int streak = Interlocked.Increment(ref consecutiveTimeouts);
                Log("call " + capturedMethod + " timed out after " + timeoutMs + "ms (streak " + streak + ")");
                if (streak >= MaxConsecutiveTimeouts)
                {
                    Log("too many consecutive timeouts; exiting so the host can restart the sidecar");
                    Thread.Sleep(100);
                    Environment.Exit(3);
                }
            }
            else
            {
                Interlocked.Exchange(ref consecutiveTimeouts, 0);
            }
            return true;
        }

        /// <summary>Wait-style calls are allowed to run longer than the default watchdog window.</summary>
        private static int TimeoutFor(string method, D prms, string line)
        {
            if (method == "ping" || method == "shutdown") return 8000;
            if (method == "wait")
            {
                int requested = A.Int(prms, "timeoutMs", 8000);
                if (requested < 100) requested = 100;
                if (requested > 120000) requested = 120000;
                return requested + 10000;
            }
            if (method == "launch")
            {
                int requested = A.Int(prms, "waitMs", 0);
                if (requested > 0) return Math.Min(requested, 120000) + 10000;
            }
            int explicitTimeout = A.Int(prms, "_timeoutMs", 0);
            if (explicitTimeout > 0) return Math.Min(explicitTimeout, 300000);
            if (line.Length > 200000) return 60000;
            return DefaultTimeoutMs;
        }

        private static object Dispatch(string method, D prms)
        {
            switch (method)
            {
                case "ping": return Ops.Ping(prms);
                case "list_windows": return Ops.ListWindows(prms);
                case "window": return Ops.WindowOp(prms);
                case "snapshot": return Ops.Snapshot(prms);
                case "inspect": return Ops.Inspect(prms);
                case "act": return Ops.Act(prms);
                case "type": return Ops.TypeText(prms);
                case "key": return Ops.Key(prms);
                case "wait": return Ops.Wait(prms);
                case "launch": return Ops.Launch(prms);
                case "clipboard": return Ops.Clipboard(prms);
                case "screenshot": return Ops.Screenshot(prms);
                default:
                    throw new Fail("METHOD_NOT_FOUND", "unknown method \"" + method + "\"",
                        "Call ping to list the supported methods.");
            }
        }

        private static D ResultOk()
        {
            D d = A.New();
            A.Put(d, "ok", true);
            return d;
        }

        private static void Respond(object id, object result)
        {
            Interlocked.Increment(ref handled);
            D envelope = A.New();
            A.PutAlways(envelope, "id", id);
            A.Put(envelope, "ok", true);
            A.PutAlways(envelope, "result", result == null ? A.New() : result);
            WriteLine(envelope);
        }

        private static void RespondError(object id, string code, string message, string hint)
        {
            Interlocked.Increment(ref failed);
            D error = A.New();
            A.Put(error, "code", code);
            A.Put(error, "message", message);
            A.Put(error, "hint", hint);
            D envelope = A.New();
            A.PutAlways(envelope, "id", id);
            A.Put(envelope, "ok", false);
            A.Put(envelope, "error", error);
            WriteLine(envelope);
        }

        private static void Emit(string eventName, object data)
        {
            D envelope = A.New();
            A.Put(envelope, "event", eventName);
            A.PutAlways(envelope, "data", data == null ? A.New() : data);
            WriteLine(envelope);
        }

        private static void WriteLine(D payload)
        {
            string text;
            try { text = json.Serialize(payload); }
            catch (Exception ex)
            {
                Log("serialize failed: " + ex.Message);
                D fallback = A.New();
                A.Put(fallback, "id", null);
                A.Put(fallback, "ok", false);
                D error = A.New();
                A.Put(error, "code", "SERIALIZE_FAILED");
                A.Put(error, "message", ex.Message);
                A.Put(error, "hint", "The result was too large or contained an unprintable value; narrow the request (smaller maxDepth/maxNodes or a query).");
                A.Put(fallback, "error", error);
                text = json.Serialize(fallback);
            }
            lock (writeGate)
            {
                try
                {
                    output.Write(text);
                    output.Write('\n');
                    output.Flush();
                }
                catch (Exception ex)
                {
                    Log("stdout write failed: " + ex.Message);
                }
            }
        }

        private static void Log(string message)
        {
            try { Console.Error.WriteLine("[uia] " + message); }
            catch { }
        }

        /// <summary>Child-process target for build scripts and the doctor command.</summary>
        private static int SelfTest()
        {
            int problems = 0;
            TextWriter outw = Console.Out;
            Dpi.Enable();
            outw.WriteLine("UiaSidecar self-test");
            outw.WriteLine("  dpi awareness : " + Dpi.Mode);
            outw.WriteLine("  os            : " + Environment.OSVersion.VersionString);
            outw.WriteLine("  clr           : " + Environment.Version);

            try
            {
                D ping = (D)Ops.Ping(A.New());
                outw.WriteLine("  ping          : ok, elevated=" + ping["elevated"]);
            }
            catch (Exception ex)
            {
                outw.WriteLine("  ping          : FAILED " + ex.Message);
                problems++;
            }

            try
            {
                D listed = (D)Ops.ListWindows(A.New());
                List<object> windows = listed["windows"] as List<object>;
                int count = windows == null ? 0 : windows.Count;
                outw.WriteLine("  windows       : " + count.ToString(CultureInfo.InvariantCulture) + " visible top-level windows");
                if (count == 0)
                {
                    outw.WriteLine("                  (no windows to inspect; this is normal only in a session without a desktop)");
                }
                for (int i = 0; i < count && i < 5; i++)
                {
                    D w = (D)windows[i];
                    outw.WriteLine("    - pid " + Convert.ToString(w["pid"], CultureInfo.InvariantCulture)
                        + " " + Convert.ToString(w["process"], CultureInfo.InvariantCulture)
                        + " \"" + A.Clip(Convert.ToString(w["title"], CultureInfo.InvariantCulture), 50) + "\"");
                }
            }
            catch (Exception ex)
            {
                outw.WriteLine("  windows       : FAILED " + ex.Message);
                problems++;
            }

            try
            {
                D snap = (D)Ops.Snapshot(A.New());
                D win = snap["window"] as D;
                string title = win == null ? "?" : A.Clip(A.Str(win, "name", ""), 40);
                outw.WriteLine("  snapshot      : " + Convert.ToString(snap["nodes"], CultureInfo.InvariantCulture)
                    + " nodes in " + Convert.ToString(snap["elapsedMs"], CultureInfo.InvariantCulture) + "ms from \""
                    + title + "\"");
            }
            catch (Exception ex)
            {
                outw.WriteLine("  snapshot      : FAILED " + ex);
                problems++;
            }

            try
            {
                D shot = (D)Ops.Screenshot(A.New());
                outw.WriteLine("  screenshot    : " + Convert.ToString(shot["width"], CultureInfo.InvariantCulture) + "x"
                    + Convert.ToString(shot["height"], CultureInfo.InvariantCulture) + " -> "
                    + Convert.ToString(shot["path"], CultureInfo.InvariantCulture));
            }
            catch (Exception ex)
            {
                outw.WriteLine("  screenshot    : FAILED " + ex.Message);
                problems++;
            }

            try
            {
                D clip = (D)Ops.Clipboard(A.New());
                outw.WriteLine("  clipboard     : readable, " + Convert.ToString(clip["length"], CultureInfo.InvariantCulture) + " chars");
            }
            catch (Exception ex)
            {
                outw.WriteLine("  clipboard     : FAILED " + ex.Message);
                problems++;
            }

            outw.WriteLine(problems == 0 ? "RESULT: PASS" : "RESULT: " + problems.ToString(CultureInfo.InvariantCulture) + " check(s) failed");
            outw.Flush();
            return problems == 0 ? 0 : 1;
        }
    }
}
