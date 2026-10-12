// SSH key manager: list / generate / import / delete keys stored in the vault.
import { open } from "@tauri-apps/plugin-dialog";
import { Copy, FileUp, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Confirm, Dialog, Empty, Field, toast } from "../../components/ui";
import { api, errMsg, type KeyEntry } from "../../lib/api";
import "./hosts.css";

type Mode = "list" | "generate" | "import";

function shortPub(pub: string) {
  const parts = pub.trim().split(/\s+/);
  const body = parts[1] ?? parts[0] ?? "";
  return `${parts[0] ?? ""} …${body.slice(-16)}`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("公钥已复制", "success");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export function KeyManager(props: { onClose: () => void; onChanged?: (keys: KeyEntry[], created?: KeyEntry) => void }) {
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [mode, setMode] = useState<Mode>("list");
  const [name, setName] = useState("");
  const [priv, setPriv] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<KeyEntry | null>(null);
  const [deleting, setDeleting] = useState<KeyEntry | null>(null);

  const reload = async (newKey?: KeyEntry) => {
    try {
      const list = await api.keyList();
      setKeys(list);
      props.onChanged?.(list, newKey);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const reset = (m: Mode) => {
    setMode(m);
    setName("");
    setPriv("");
    setPass("");
    setError("");
    setCreated(null);
  };

  const pickFile = async () => {
    try {
      const path = await open({ multiple: false, directory: false, title: "选择私钥文件" });
      if (typeof path !== "string") return;
      const text = await api.localReadText(path);
      setPriv(text);
      if (!name.trim()) setName(path.split(/[\\/]/).pop() ?? "");
      setError("");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const submit = async () => {
    if (!name.trim()) return setError("请填写名称");
    if (mode === "import" && !priv.trim()) return setError("请粘贴私钥或选择文件");
    setBusy(true);
    setError("");
    try {
      const k =
        mode === "generate"
          ? await api.keyGenerate(name.trim())
          : await api.keyImport(name.trim(), priv, pass || undefined);
      await reload(k);
      if (mode === "generate") setCreated(k);
      else {
        toast("密钥已导入", "success");
        reset("list");
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const footer =
    mode === "list" ? (
      <>
        <button className="btn" onClick={() => reset("import")}>
          <FileUp /> 导入
        </button>
        <button className="btn primary" onClick={() => reset("generate")}>
          <Plus /> 生成
        </button>
      </>
    ) : created ? (
      <button className="btn primary" onClick={() => reset("list")}>完成</button>
    ) : (
      <>
        <button className="btn" onClick={() => reset("list")}>返回</button>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? "处理中…" : mode === "generate" ? "生成" : "导入"}
        </button>
      </>
    );

  return (
    <>
      <Dialog
        title={mode === "list" ? "密钥" : mode === "generate" ? "生成密钥" : "导入密钥"}
        width={560}
        onClose={deleting ? () => {} : props.onClose}
        footer={footer}
      >
        {mode === "list" &&
          (keys.length === 0 ? (
            <Empty icon={<KeyRound />} text="还没有密钥" />
          ) : (
            <div className="km-list">
              {keys.map((k) => (
                <div className="km-row" key={k.id}>
                  <span className="name ellipsis" title={k.name}>{k.name}</span>
                  <span className="grow ellipsis mono faint pub" title={k.publicKey}>
                    {shortPub(k.publicKey)}
                  </span>
                  <button className="icon-btn" title="复制公钥" onClick={() => copy(k.publicKey)}>
                    <Copy />
                  </button>
                  <button className="icon-btn" title="删除" onClick={() => setDeleting(k)}>
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          ))}

        {mode !== "list" && created && (
          <div className="stack gap-3">
            <div className="muted">
              添加到服务器 <span className="mono">~/.ssh/authorized_keys</span>
            </div>
            <div className="km-pub">{created.publicKey}</div>
            <div className="row">
              <button className="btn sm" onClick={() => copy(created.publicKey)}>
                <Copy /> 复制公钥
              </button>
            </div>
          </div>
        )}

        {mode !== "list" && !created && (
          <form
            className="he-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field label="名称">
              <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="work-ed25519" />
            </Field>
            {mode === "generate" && (
              <Field label="类型">
                <span className="faint">Ed25519</span>
              </Field>
            )}
            {mode === "import" && (
              <>
                <Field label="私钥" top>
                  <div className="stack grow">
                    <textarea
                      className="textarea mono"
                      rows={7}
                      value={priv}
                      onChange={(e) => setPriv(e.target.value)}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      spellCheck={false}
                      style={{ fontSize: "var(--fs-xs)" }}
                    />
                    <div className="row">
                      <button type="button" className="btn sm" onClick={pickFile}>
                        <FileUp /> 选择文件
                      </button>
                    </div>
                  </div>
                </Field>
                <Field label="私钥密码">
                  <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
                </Field>
              </>
            )}
            {error && (
              <Field label="">
                <span className="he-err selectable">{error}</span>
              </Field>
            )}
            <button type="submit" hidden />
          </form>
        )}
      </Dialog>

      {deleting && (
        <Confirm
          title="删除密钥"
          message={`删除「${deleting.name}」后，使用它的服务器将无法登录。`}
          confirmText="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const k = deleting;
            setDeleting(null);
            try {
              await api.keyDelete(k.id);
              await reload();
            } catch (e) {
              toast(errMsg(e), "error");
            }
          }}
        />
      )}
    </>
  );
}
