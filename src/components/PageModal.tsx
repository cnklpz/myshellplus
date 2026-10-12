// Large modal hosting a full page view (batch, tunnels, snippets, agent, settings).
// Content stays mounted while hidden so running work (e.g. a batch) and its state survive closing.
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { EscLayer, HideDialogs, useEscClose } from "./ui";

export function PageModal(props: { open: boolean; onClose: () => void; width?: number; children: ReactNode }) {
  useEscClose(props.onClose, props.open);
  return (
    <div
      className="overlay page-modal-overlay"
      style={{ display: props.open ? "flex" : "none" }}
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="page-modal" style={{ width: props.width ?? 1120 }}>
        <button className="icon-btn md page-modal-close" title="关闭" onClick={props.onClose}>
          <X />
        </button>
        <HideDialogs when={!props.open}>
          <EscLayer>{props.children}</EscLayer>
        </HideDialogs>
      </div>
    </div>
  );
}
