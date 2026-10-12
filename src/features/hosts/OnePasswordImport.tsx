// "Import from 1Password" dialog opened from the new-host editor. Lists SSH key / server / login items
// through the `op` CLI (or only the agent's keys when the CLI is missing) and hands the parsed fields back.
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Select } from "../../components/Select";
import { Dialog, Field, toast } from "../../components/ui";
import { api, errMsg, type OpHost, type OpItem, type OpStatus } from "../../lib/api";

const CATEGORY: Record<string, string> = { SSH_KEY: "SSH 密钥", AGENT: "SSH 密钥", SERVER: "服务器", LOGIN: "登录" };

export function OnePasswordImport(props: { status: OpStatus; onPick: (h: OpHost) => void; onClose: () => void }) {
  const { status } = props;
  const [account, setAccount] = useState(status.accounts[0]?.id ?? "");
  const [items, setItems] = useState<OpItem[] | null>(null);
  const [picked, setPicked] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState<"" | "list" | "item">("");
  const [err, setErr] = useState("");

  const load = async (acc = account) => {
    setBusy("list");
    setErr("");
    try {
      setItems(await api.opItems(acc || undefined));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  // Opening the dialog is the explicit request, so list items right away (once, despite StrictMode).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load();
  }, []);

  const apply = (h: OpHost) => {
    const got = [h.host && "地址", h.username && "用户名", h.keyFingerprint ? "密钥" : h.password ? "密码" : ""].filter(Boolean);
    if (!got.length) {
      setErr("条目中没有可用字段");
      return;
    }
    props.onPick(h);
    toast(`已读取${got.join("、")}`, "success");
    props.onClose();
  };

  const read = async (reference: string) => {
    if (!reference.trim()) return;
    setBusy("item");
    setErr("");
    try {
      apply(await api.opItem(reference.trim(), account || undefined));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const pick = (id: string) => {
    setPicked(id);
    const it = items?.find((x) => x.id === id);
    if (!it) return;
    // Agent-only fallback: the id is the key fingerprint, nothing else to read.
    if (it.category === "AGENT") apply({ title: it.title, host: "", username: "", keyFingerprint: it.id });
    else read(it.id);
  };

  return (
    <Dialog
      title="从 1Password 导入"
      width={480}
      onClose={props.onClose}
      footer={
        <button className="btn" onClick={props.onClose}>
          取消
        </button>
      }
    >
      <div className="stack gap-3">
        {status.accounts.length > 1 && (
          <Field label="账号">
            <Select
              width="100%"
              value={account}
              options={status.accounts.map((a) => ({ value: a.id, label: a.email, hint: a.url }))}
              onChange={(v) => {
                setAccount(v);
                setPicked("");
                load(v);
              }}
            />
          </Field>
        )}
        <Field label="条目">
          {items ? (
            <>
              <Select
                width="100%"
                value={picked}
                disabled={busy === "item"}
                options={[
                  { value: "", label: items.length ? "选择条目" : "无可用条目" },
                  ...items.map((it) => ({
                    value: it.id,
                    label: it.title || it.id,
                    text: it.title,
                    hint: [CATEGORY[it.category] ?? it.category, it.vault].filter(Boolean).join(" · "),
                  })),
                ]}
                onChange={pick}
              />
              <button type="button" className="link-btn" disabled={!!busy} onClick={() => load()}>
                刷新
              </button>
            </>
          ) : (
            <button type="button" className="btn" disabled={!!busy} onClick={() => load()}>
              {busy === "list" ? <LoaderCircle className="spin" /> : <RefreshCw />}
              {busy === "list" ? "等待 1Password…" : "读取条目"}
            </button>
          )}
        </Field>
        <Field label="条目 ID" hint={!err && !status.cli ? "未安装 CLI，只能读取密钥" : undefined}>
          <div className="row grow he-key-row">
            <input
              className="input mono"
              value={ref}
              disabled={!status.cli}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  read(ref);
                }
              }}
              placeholder="op://Private/web-01"
              spellCheck={false}
            />
            <button type="button" className="btn" disabled={!status.cli || !ref.trim() || !!busy} onClick={() => read(ref)}>
              {busy === "item" ? <LoaderCircle className="spin" /> : null}
              读取
            </button>
          </div>
        </Field>
        {err && (
          <Field label="">
            <span className="he-err selectable">{err}</span>
          </Field>
        )}
      </div>
    </Dialog>
  );
}
