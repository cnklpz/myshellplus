// The one way to copy text: writes the clipboard and reports the result as a toast.
import { toast } from "../components/ui";

/**
 * Copy `text` and toast "已复制{what}". `what` names the kind of thing ("地址", "命令"), never the
 * value itself, so the toast cannot leak an address in privacy mode. `silent` skips the success toast.
 */
export async function copyText(text: string, what = "", opts: { silent?: boolean } = {}): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (!opts.silent) toast(`已复制${what}`, "success");
    return true;
  } catch {
    toast("无法写入剪贴板", "error");
    return false;
  }
}
