/**
 * 把命令输出的 ANSI 转义序列转成带样式的 HTML：
 * - SGR（\\x1b[..m）：前景色 30-37/90-97、256 色（38;5;n）、truecolor（38;2;r;g;b）、粗体/暗淡/斜体/下划线；
 * - 其余转义（OSC 标题、光标移动等）剥离；
 * - 先做 HTML 转义再生成 span，命令输出无法注入 HTML。
 * 颜色映射与 GUI 暗色主题一致。
 */

/** 基础 8 色 + 高亮 8 色（0-15 的 xterm 映射；黑色提亮为可读灰） */
const BASE16 = {
  30: "#546070", 31: "#ff6b6b", 32: "#4cc38a", 33: "#f5a623",
  34: "#4da3ff", 35: "#c678dd", 36: "#56b6c2", 37: "#d7dee8",
  90: "#8a97a8", 91: "#ff8787", 92: "#7ee2ad", 93: "#ffc46b",
  94: "#7db8ff", 95: "#d69df0", 96: "#7fd8e5", 97: "#ffffff",
};
const XTERM0_15 = [
  "#546070", "#ff6b6b", "#4cc38a", "#f5a623", "#4da3ff", "#c678dd", "#56b6c2", "#d7dee8",
  "#8a97a8", "#ff8787", "#7ee2ad", "#ffc46b", "#7db8ff", "#d69df0", "#7fd8e5", "#ffffff",
];

/** @param {number} n */
function xterm256(n) {
  if (n < 16) return XTERM0_15[n] ?? "#d7dee8";
  if (n < 232) {
    const i = n - 16;
    const lv = [0, 95, 135, 175, 215, 255];
    const r = lv[Math.floor(i / 36)], g = lv[Math.floor((i % 36) / 6)], b = lv[i % 6];
    return `rgb(${r},${g},${b})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/**
 * @param {{fg: string | null, bold: boolean, dim: boolean, italic: boolean, underline: boolean}} st
 * @param {string} seq 分号分隔的 SGR 码
 */
function applySgr(st, seq) {
  const codes = seq.split(";").map(x => (x === "" ? 0 : parseInt(x, 10)));
  let i = 0;
  while (i < codes.length) {
    const c = codes[i];
    if (c === 0) { st.fg = null; st.bold = st.dim = st.italic = st.underline = false; }
    else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 3) st.italic = true;
    else if (c === 4) st.underline = true;
    else if (c === 22) { st.bold = false; st.dim = false; }
    else if (c === 23) st.italic = false;
    else if (c === 24) st.underline = false;
    else if (c === 39) st.fg = null;
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = BASE16[c];
    else if (c === 38 || c === 48) {
      // 38;5;n / 38;2;r;g;b（仅前景；bg 码按同结构跳过）
      if (codes[i + 1] === 5) {
        if (c === 38) st.fg = xterm256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2) {
        if (c === 38) st.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      } else break; // 畸形序列，停止本段解析
    }
    i++;
  }
}

/** @param {{fg: string | null, bold: boolean, dim: boolean, italic: boolean, underline: boolean}} st */
function cssOf(st) {
  const parts = [];
  if (st.fg) parts.push(`color:${st.fg}`);
  if (st.bold) parts.push("font-weight:700");
  if (st.dim) parts.push("opacity:.65");
  if (st.italic) parts.push("font-style:italic");
  if (st.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

/**
 * ANSI 文本 → HTML（span 着色）。输入先 HTML 转义，输出可安全 {@html}。
 * @param {string} raw
 */
export function ansiToHtml(raw) {
  let s = String(raw ?? "").replace(/\r/g, "");
  // OSC（窗口标题等）剥离
  s = s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  // HTML 转义（先于 span 生成，命令输出无法注入）
  s = s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const st = { fg: null, bold: false, dim: false, italic: false, underline: false };
  let out = "";
  let spanOpen = false;
  const close = () => { if (spanOpen) { out += "</span>"; spanOpen = false; } };
  const apply = () => {
    close();
    const css = cssOf(st);
    if (css) { out += `<span style="${css}">`; spanOpen = true; }
  };

  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m;
  while ((m = re.exec(s))) {
    out += s.slice(last, m.index);
    applySgr(st, m[1]);
    apply();
    last = m.index + m[0].length;
  }
  out += s.slice(last);

  // 残余非 SGR 转义（光标移动/清屏/游离 ESC）剥离
  out = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b/g, "");
  close();
  return out;
}
