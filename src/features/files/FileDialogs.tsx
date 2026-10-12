// Dialogs used by the files panel: text editor, chmod, single-name prompt.
import { Fragment, useEffect, useRef, useState } from "react";
import { Confirm, Dialog, Field, toast } from "../../components/ui";
import { api, errMsg, type FileEntry } from "../../lib/api";
import { fmtBytes, fmtPerms } from "../../lib/format";

export function EditorDialog(props: { hostId: string; path: string; name: string; onClose: () => void; onSaved?: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const dirty = text !== null && text !== orig;
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .sftpRead(props.hostId, props.path)
      .then((t) => {
        if (!alive) return;
        setText(t);
        setOrig(t);
        requestAnimationFrame(() => taRef.current?.focus());
      })
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [props.hostId, props.path]);

  const save = async () => {
    if (text === null || saving) return;
    setSaving(true);
    try {
      await api.sftpWrite(props.hostId, props.path, text);
      setOrig(text);
      toast("已保存", "success");
      props.onSaved?.();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const close = () => (dirty ? setAskClose(true) : props.onClose());

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: a, selectionEnd: b, value } = ta;
      const next = value.slice(0, a) + "\t" + value.slice(b);
      setText(next);
      requestAnimationFrame(() => ta.setSelectionRange(a + 1, a + 1));
    }
  };

  return (
    <>
      <Dialog
        width={900}
        onClose={askClose ? () => {} : close}
        title={
          <span className="fp-ed-title">
            {dirty && <span className="dot warn" title="未保存" />}
            <span className="ellipsis">{props.name}</span>
            <span className="path ellipsis" title={props.path}>{props.path}</span>
          </span>
        }
        footer={
          <>
            <span className="fp-ed-status">{dirty ? "未保存" : ""}</span>
            <button className="btn" onClick={close}>关闭</button>
            <button className="btn primary" title="Ctrl+S" disabled={text === null || !dirty || saving} onClick={save}>
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        {error ? (
          <div className="selectable fp-ed-error">{error}</div>
        ) : text === null ? (
          <div className="faint">加载中…</div>
        ) : (
          <textarea
            ref={taRef}
            className="textarea fp-editor"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
        )}
      </Dialog>
      {askClose && (
        <Confirm
          title="放弃修改？"
          message="未保存的修改将丢失。"
          confirmText="放弃"
          danger
          onCancel={() => setAskClose(false)}
          onConfirm={props.onClose}
        />
      )}
    </>
  );
}

const WHO = ["所有者", "组", "其他"];
const WHAT = ["读", "写", "执行"];

export function ChmodDialog(props: { hostId: string; entries: FileEntry[]; onClose: () => void; onDone: () => void }) {
  const first = props.entries[0];
  const [mode, setMode] = useState(first.perms & 0o777);
  const [octal, setOctal] = useState((first.perms & 0o777).toString(8).padStart(3, "0"));
  const [busy, setBusy] = useState(false);

  const setBits = (m: number) => {
    setMode(m);
    setOctal(m.toString(8).padStart(3, "0"));
  };
  const onOctal = (v: string) => {
    const clean = v.replace(/[^0-7]/g, "").slice(0, 4);
    setOctal(clean);
    if (clean.length >= 3) setMode(parseInt(clean, 8) & 0o777);
  };
  const apply = async () => {
    const full = octal.length === 4 ? parseInt(octal, 8) : mode;
    setBusy(true);
    try {
      for (const e of props.entries) await api.sftpChmod(props.hostId, e.path, full);
      toast("权限已修改", "success");
      props.onDone();
      props.onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={props.entries.length > 1 ? `权限 · ${props.entries.length} 项` : `权限 · ${first.name}`}
      width={400}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={busy || octal.length < 3} onClick={apply}>应用</button>
        </>
      }
    >
      <div className="stack gap-4">
        <div className="fp-chmod">
          <span />
          {WHAT.map((w) => (
            <span key={w} className="hd">{w}</span>
          ))}
          {WHO.map((who, wi) => (
            <Fragment key={who}>
              <span>{who}</span>
              {WHAT.map((_, bi) => {
                const bit = 1 << ((2 - wi) * 3 + (2 - bi));
                return (
                  <label key={bi}>
                    <input type="checkbox" checked={(mode & bit) !== 0} onChange={(e) => setBits(e.target.checked ? mode | bit : mode & ~bit)} />
                  </label>
                );
              })}
            </Fragment>
          ))}
        </div>
        <Field label="八进制">
          <input className="input mono fp-octal" value={octal} onChange={(e) => onOctal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
          <span className="faint mono">{fmtPerms(mode, first.isDir)}</span>
        </Field>
        {props.entries.length === 1 && (
          <Field label="所有者">
            <span className="muted">{first.owner || "-"}</span>
            {!first.isDir && <span className="faint">· {fmtBytes(first.size)}</span>}
          </Field>
        )}
      </div>
    </Dialog>
  );
}


export function NamePrompt(props: {
  title: string;
  label: string;
  initial?: string;
  confirmText?: string;
  onSubmit: (name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== "" && !name.includes("/");
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await props.onSubmit(name.trim());
      props.onClose();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={props.title}
      width={420}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn primary" disabled={!valid || busy} onClick={submit}>{props.confirmText ?? "确定"}</button>
        </>
      }
    >
      <Field label={props.label}>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </Field>
    </Dialog>
  );
}
