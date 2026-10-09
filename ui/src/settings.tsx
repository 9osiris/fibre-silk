import { useEffect, useState } from "react";
import type { SilkBridge, SilkConfig } from "./silk.d";

function getBridge(): SilkBridge | undefined {
  return typeof window !== "undefined" ? window.silk : undefined;
}

function blank(): SilkConfig {
  return {
    providers: {
      openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "", keySet: false },
      anthropic: { apiKey: "", model: "", keySet: false },
    },
    activeProvider: "openai",
    workspaceDir: "",
  };
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<SilkConfig>(blank);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    const b = getBridge();
    if (b) {
      b.getSettings()
        .then((cur) => {
          const next = blank();
          next.activeProvider = cur.activeProvider ?? "openai";
          if (cur.providers?.openai)
            next.providers.openai = { ...next.providers.openai, ...cur.providers.openai };
          if (cur.providers?.anthropic)
            next.providers.anthropic = {
              ...next.providers.anthropic,
              ...cur.providers.anthropic,
            };
          setS(next);
        })
        .catch(() => {})
        .finally(() => setLoaded(true));
    } else {
      setLoaded(true);
    }
  }, []);

  const prov = s.activeProvider;

  const setField = (key: "apiKey" | "baseUrl" | "model", v: string) =>
    setS((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prov]: { ...prev.providers[prov], [key]: v },
      },
    }));

  const cur = s.providers[prov] ?? { apiKey: "", model: "", keySet: false };
  const keyPlaceholder = cur.keySet ? "key is set (type to replace)" : "sk-...";

  const save = async () => {
    const b = getBridge();
    if (b) await b.saveSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // sends a tiny ping through the configured provider. the key never
  // leaves main; only ok/message comes back.
  const test = async () => {
    const b = getBridge();
    if (!b) {
      setTestResult({ ok: false, message: "no bridge (not in electron)" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await b.testProvider());
    } catch (e) {
      setTestResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span>settings</span>
          <button onClick={onClose} title="close">
            close
          </button>
        </div>
        {!loaded ? (
          <div className="empty">loading...</div>
        ) : (
          <>
            <label>
              provider
              <select
                value={s.activeProvider}
                onChange={(e) =>
                  setS((p) => ({
                    ...p,
                    activeProvider: e.target.value as SilkConfig["activeProvider"],
                  }))
                }
              >
                <option value="openai">openai-compatible</option>
                <option value="anthropic">anthropic</option>
              </select>
            </label>
            <label>
              api key
              <input
                type="password"
                value={cur.apiKey}
                onChange={(e) => setField("apiKey", e.target.value)}
                placeholder={keyPlaceholder}
                autoComplete="off"
              />
            </label>
            {prov === "openai" && (
              <label>
                base url
                <input
                  type="text"
                  value={(cur as { baseUrl?: string }).baseUrl ?? ""}
                  onChange={(e) => setField("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  autoComplete="off"
                />
              </label>
            )}
            <label>
              model
              <input
                type="text"
                value={cur.model}
                onChange={(e) => setField("model", e.target.value)}
                placeholder={prov === "anthropic" ? "claude-..." : "gpt-..."}
                autoComplete="off"
              />
            </label>
            <p className="note">
              your keys stay on this machine. nothing is sent anywhere except
              the provider you pick.
            </p>
            <label>
              workspace folder (project the coding agent works in)
              <input
                type="text"
                value={s.workspaceDir ?? ""}
                onChange={(e) =>
                  setS((prev) => ({ ...prev, workspaceDir: e.target.value }))
                }
                placeholder="c:\users\you\projects\my-app (blank = plain chat)"
                autoComplete="off"
              />
            </label>
            <div className="btn-row">
              <button className="send" onClick={save}>
                {saved ? "saved" : "save"}
              </button>
              <button onClick={test} disabled={testing}>
                {testing ? "testing..." : "test connection"}
              </button>
            </div>
            {testResult && (
              <p className={testResult.ok ? "test-ok" : "test-fail"}>
                {testResult.ok ? "ok: " : "failed: "}
                {testResult.message}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
