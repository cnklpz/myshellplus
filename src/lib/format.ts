export function fmtBytes(n: number, digits = 1): string {
  if (!isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(digits)} ${units[i]}`;
}

export const fmtRate = (n: number) => `${fmtBytes(n)}/s`;

export function fmtPct(n: number, digits = 0): string {
  return `${(isFinite(n) ? n : 0).toFixed(digits)}%`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtPerms(mode: number, isDir: boolean): string {
  const s = (isDir ? "d" : "-") + "rwxrwxrwx";
  return s
    .split("")
    .map((c, i) => (i === 0 ? c : mode & (1 << (9 - i)) ? c : "-"))
    .join("");
}
