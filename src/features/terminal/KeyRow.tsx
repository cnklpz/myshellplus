// Mobile: keys the soft keyboard lacks, above it. Buttons never take focus so the keyboard stays up.
import { Ellipsis } from "lucide-react";
import { useRef } from "react";
import { toggleMod, useMods } from "../../lib/mobileKeys";
import { type MenuItem, useContextMenu } from "./ContextMenu";

const arrow = (c: string) => (app: boolean) => (app ? "\x1bO" : "\x1b[") + c;

const KEYS: { label: string; seq: string | ((appCursor: boolean) => string) }[] = [
  { label: "←", seq: arrow("D") },
  { label: "↑", seq: arrow("A") },
  { label: "↓", seq: arrow("B") },
  { label: "→", seq: arrow("C") },
  { label: "|", seq: "|" },
  { label: "/", seq: "/" },
  { label: "-", seq: "-" },
  { label: "~", seq: "~" },
  { label: "Home", seq: "\x1b[H" },
  { label: "End", seq: "\x1b[F" },
  { label: "PgUp", seq: "\x1b[5~" },
  { label: "PgDn", seq: "\x1b[6~" },
];

/** Keep the terminal's textarea focused (and the keyboard up) when a key is tapped. */
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

export function KeyRow(props: {
  send: (data: string) => void;
  appCursor: () => boolean;
  /** Terminal tools behind the "⋯" button (the desktop tool strip). */
  tools: MenuItem[];
}) {
  const mods = useMods();
  const menu = useContextMenu();
  // The menu closes itself on the outside press; a tap on "⋯" while it was open only closes it.
  const wasOpen = useRef(false);
  const key = (label: string, seq: () => string) => (
    <button key={label} className="key-btn" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => props.send(seq())}>
      {label}
    </button>
  );
  return (
    <div className="key-row">
      <div className="key-scroll">
        {key("Esc", () => "\x1b")}
        {key("Tab", () => "\t")}
        {(["ctrl", "alt"] as const).map((m) => (
          <button
            key={m}
            className={"key-btn" + (mods[m] ? " on" : "")}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => toggleMod(m)}
          >
            {m === "ctrl" ? "Ctrl" : "Alt"}
          </button>
        ))}
        {KEYS.map((k) => key(k.label, () => (typeof k.seq === "string" ? k.seq : k.seq(props.appCursor()))))}
      </div>
      <button
        className="key-btn tool"
        title="更多"
        onPointerDown={(e) => {
          keepFocus(e);
          wasOpen.current = menu.isOpen;
        }}
        onMouseDown={keepFocus}
        onClick={(e) => {
          if (wasOpen.current) {
            wasOpen.current = false;
            menu.close();
          } else menu.open(e, props.tools);
        }}
      >
        <Ellipsis />
      </button>
      {menu.node}
    </div>
  );
}
