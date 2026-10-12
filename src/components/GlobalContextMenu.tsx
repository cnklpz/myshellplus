// Replaces the WebView2 browser context menu (back / reload / inspect…) everywhere in the app.
// Components with their own menus (terminal, host list, files, home cards) call preventDefault();
// everything else gets this menu: edit actions in text fields, copy/search for selected text,
// and app actions on empty space.
import {
  ClipboardPaste, Copy, Download, Plus, Scissors, Search, Settings, SquareTerminal, TextSelect, Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ContextMenu, type MenuItem } from "../features/terminal/ContextMenu";
import { useApp } from "../store";
import { copyText } from "../lib/clipboard";
import { toast } from "./ui";

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
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // a component showed its own menu
      e.preventDefault(); // never show the browser menu
      setMenu({ x: e.clientX, y: e.clientY, items: build(e) });
    };
    window.addEventListener("contextmenu", onContext);
    return () => window.removeEventListener("contextmenu", onContext);
  }, []);

  return menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
}

function build(e: MouseEvent): MenuItem[] {
  const field = editableOf(e.target);
  const selected = (field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : window.getSelection()?.toString() ?? "").trim();
  const copy = (text: string) => void copyText(text, "", { silent: true });

  if (field) {
    const ro = field.readOnly || field.disabled;
    const hasSel = (field.selectionEnd ?? 0) > (field.selectionStart ?? 0);
    return [
      { label: "撤销", icon: <Undo2 />, hint: "Ctrl+Z", disabled: ro, onSelect: () => (field.focus(), document.execCommand("undo")) },
      "sep",
      {
        label: "剪切", icon: <Scissors />, hint: "Ctrl+X", disabled: ro || !hasSel,
        onSelect: () => {
          copy(selected || field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0));
          insertText(field, "");
        },
      },
      { label: "复制", icon: <Copy />, hint: "Ctrl+C", disabled: !hasSel, onSelect: () => copy(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)) },
      {
        label: "粘贴", icon: <ClipboardPaste />, hint: "Ctrl+V", disabled: ro,
        onSelect: () => navigator.clipboard.readText().then((t) => insertText(field, t), () => toast("无法读取剪贴板", "error")),
      },
      "sep",
      { label: "全选", icon: <TextSelect />, hint: "Ctrl+A", onSelect: () => (field.focus(), field.select()) },
    ];
  }

  const s = useApp.getState();
  const items: MenuItem[] = [];
  if (selected) {
    items.push(
      { label: "复制", icon: <Copy />, hint: "Ctrl+C", onSelect: () => copy(selected) },
      { label: `搜索“${selected.length > 16 ? selected.slice(0, 16) + "…" : selected}”`, icon: <Search />, onSelect: () => openSearch(selected) },
      "sep",
    );
  }
  items.push(
    { label: "搜索", icon: <Search />, hint: "Ctrl+P", onSelect: () => openSearch("") },
    { label: "新建服务器", icon: <Plus />, onSelect: () => s.openEditor("") },
    { label: "导入服务器", icon: <Download />, onSelect: () => s.setImportOpen(true) },
    { label: s.view === "terminal" ? "首页" : "终端", icon: <SquareTerminal />, onSelect: () => s.setView(s.view === "terminal" ? "home" : "terminal") },
    "sep",
    { label: "设置", icon: <Settings />, onSelect: () => s.openSettings("ai") },
  );
  return items;
}

function openSearch(query: string) {
  window.dispatchEvent(new CustomEvent("msp:open-search", { detail: query }));
}
