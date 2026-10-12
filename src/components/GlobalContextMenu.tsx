// Replaces the WebView2 browser context menu (back / reload / inspect…) everywhere in the app.
// Components with their own menus (terminal, host list, files, home cards) call preventDefault();
// everything else gets this menu: edit actions in text fields, copy/search for selected text,
// and app actions on empty space.
import {
  ClipboardPaste, Copy, Download, Palette, Plus, Scissors, Search, Settings, SquareTerminal, TextSelect, Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyTheme, currentTheme, THEMES } from "../lib/themes";
import { useApp } from "../store";
import { toast } from "./ui";

interface Entry {
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  run?: () => void;
  sep?: boolean;
}

type Editable = HTMLInputElement | HTMLTextAreaElement;

function editableOf(t: EventTarget | null): Editable | null {
  const el = t as HTMLElement | null;
  if (!el) return null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(el.type)) return el;
  return null;
}

/** Insert text at the caret in a React-controlled field (fires the input event React listens to). */
function insertText(el: Editable, text: string) {
  el.focus();
  if (!document.execCommand("insertText", false, text)) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export function GlobalContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: Entry[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // a component showed its own menu
      e.preventDefault(); // never show the browser menu
      setMenu({ x: e.clientX, y: e.clientY, items: build(e) });
    };
    window.addEventListener("contextmenu", onContext);
    return () => window.removeEventListener("contextmenu", onContext);
  }, []);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const left = menu.x + r.width > window.innerWidth - 8 ? Math.max(8, menu.x - r.width) : menu.x;
    const top = menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y;
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu gctx"
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={"ctx-item" + (it.disabled ? " disabled" : "")}
            onClick={() => {
              if (it.disabled) return;
              setMenu(null);
              it.run?.();
            }}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}

function build(e: MouseEvent): Entry[] {
  const field = editableOf(e.target);
  const selected = (field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : window.getSelection()?.toString() ?? "").trim();
  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => toast("无法写入剪贴板", "error"));

  if (field) {
    const ro = field.readOnly || field.disabled;
    const hasSel = (field.selectionEnd ?? 0) > (field.selectionStart ?? 0);
    return [
      { label: "撤销", icon: <Undo2 />, hint: "Ctrl+Z", disabled: ro, run: () => (field.focus(), document.execCommand("undo")) },
      { sep: true, label: "" },
      {
        label: "剪切", icon: <Scissors />, hint: "Ctrl+X", disabled: ro || !hasSel,
        run: () => {
          copy(selected || field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0));
          insertText(field, "");
        },
      },
      { label: "复制", icon: <Copy />, hint: "Ctrl+C", disabled: !hasSel, run: () => copy(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)) },
      {
        label: "粘贴", icon: <ClipboardPaste />, hint: "Ctrl+V", disabled: ro,
        run: () => navigator.clipboard.readText().then((t) => insertText(field, t), () => toast("无法读取剪贴板", "error")),
      },
      { sep: true, label: "" },
      { label: "全选", icon: <TextSelect />, hint: "Ctrl+A", run: () => (field.focus(), field.select()) },
    ];
  }

  const s = useApp.getState();
  const items: Entry[] = [];
  if (selected) {
    items.push(
      { label: "复制", icon: <Copy />, hint: "Ctrl+C", run: () => copy(selected) },
      { label: `搜索“${selected.length > 16 ? selected.slice(0, 16) + "…" : selected}”`, icon: <Search />, run: () => openSearch(selected) },
      { sep: true, label: "" },
    );
  }
  const next = THEMES[(THEMES.findIndex((t) => t.id === currentTheme().id) + 1) % THEMES.length];
  items.push(
    { label: "搜索", icon: <Search />, hint: "Ctrl+P", run: () => openSearch("") },
    { label: "新建服务器", icon: <Plus />, run: () => s.openEditor("") },
    { label: "导入服务器", icon: <Download />, run: () => s.setImportOpen(true) },
    { label: s.view === "terminal" ? "首页" : "终端", icon: <SquareTerminal />, run: () => s.setView(s.view === "terminal" ? "home" : "terminal") },
    { sep: true, label: "" },
    { label: `主题：${next.name}`, icon: <Palette />, run: () => applyTheme(next.id) },
    { label: "设置", icon: <Settings />, run: () => s.openSettings("ai") },
  );
  return items;
}

function openSearch(query: string) {
  window.dispatchEvent(new CustomEvent("msp:open-search", { detail: query }));
}
