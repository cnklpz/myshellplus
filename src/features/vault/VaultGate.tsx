// Full-screen vault setup/unlock screen shown while locked.
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { useApp } from "../../store";
import "./vault.css";

function Logo() {
  return (
    <svg className="vg-logo" viewBox="0 0 32 32" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)" />
      <path d="M9 11l5 5-5 5" fill="none" stroke="var(--accent-fg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 21h5M21.5 18.5v5" fill="none" stroke="var(--accent-fg)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

function strength(pw: string): { score: number; label: string; cls: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length < 8) return { score: 1, label: "太短", cls: "err" };
  if (s <= 2) return { score: 2, label: "弱", cls: "err" };
  if (s === 3) return { score: 3, label: "中", cls: "warn" };
  return { score: 4, label: "强", cls: "ok" };
}

export function VaultGate() {
  const vault = useApp((s) => s.vault);
  const setup = !vault?.initialized;
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(vault?.remembered ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [setup]);

  const fail = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const submit = async () => {
    if (busy) return;
    if (setup) {
      if (pw.length < 8) return fail("主密码至少 8 位");
      if (pw !== pw2) return fail("两次输入不一致");
    } else if (!pw) {
      return fail("请输入主密码");
    }
    setBusy(true);
    setError("");
    try {
      if (setup) await api.vaultSetup(pw, remember);
      else await api.vaultUnlock(pw, remember);
      const s = useApp.getState();
      await s.refreshVault();
      await s.refreshHosts();
    } catch (e) {
      setBusy(false);
      fail(errMsg(e) || "密码错误");
    }
  };

  const st = strength(pw);

  return (
    <div className="vg">
      <form
        className={"vg-card" + (shake ? " shake" : "")}
        onAnimationEnd={() => setShake(false)}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="vg-brand">
          <Logo />
          <span>MyShell+</span>
        </div>

        <div className="stack gap-1">
          <div className="vg-title">{setup ? "设置主密码" : "解锁"}</div>
          <div className="faint vg-sub">
            {setup ? "主密码用于加密所有服务器密码和密钥，无法找回。" : "输入主密码以解锁服务器和密钥。"}
          </div>
        </div>

        <div className="stack">
          <div className="vg-pw">
            <input
              ref={inputRef}
              className="input"
              type={show ? "text" : "password"}
              placeholder={setup ? "主密码（至少 8 位）" : "主密码"}
              value={pw}
              disabled={busy}
              autoFocus
              onChange={(e) => {
                setPw(e.target.value);
                setError("");
              }}
            />
            <button type="button" className="icon-btn" tabIndex={-1} title={show ? "隐藏" : "显示"} onClick={() => setShow(!show)}>
              {show ? <EyeOff /> : <Eye />}
            </button>
          </div>
          {setup && (
            <>
              <input
                className="input"
                type={show ? "text" : "password"}
                placeholder="再次输入"
                value={pw2}
                disabled={busy}
                onChange={(e) => {
                  setPw2(e.target.value);
                  setError("");
                }}
              />
              <div className="vg-strength">
                {[1, 2, 3, 4].map((i) => (
                  <i key={i} className={pw && i <= st.score ? st.cls : ""} />
                ))}
                <span className="faint">{pw ? `强度：${st.label}` : "建议 12 位以上，混合大小写、数字和符号"}</span>
              </div>
            </>
          )}
        </div>

        <label className="vg-check">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(e) => setRemember(e.target.checked)} />
          <span>在此设备上记住（Windows 账户保护）</span>
        </label>

        {error && <div className="vg-err selectable">{error}</div>}

        <button type="submit" className="btn primary vg-submit" disabled={busy}>
          {busy && <Loader2 className="vg-spin" />}
          {setup ? "创建" : "解锁"}
        </button>
      </form>
    </div>
  );
}
