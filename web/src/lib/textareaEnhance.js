/**
 * textarea 增强action：行号（逻辑行）/ 语法高亮 overlay / 高度自适应——任意 textarea 用
 * use:enhance={{ text, lineNumbers, highlight, autoGrow, maxHeight }} 选择性应用，destroy 完整还原。
 *
 * 结构（action 自管，包一层 .ta-enhance 容器）：
 *   .ta-enhance
 *   ├─ .ta-gutter          行号列（定宽，overflow hidden，行号 span 绝对定位按逻辑行首视觉行 y）
 *   └─ .ta-edit            相对定位编辑区
 *      ├─ pre.ta-hl        高亮层（与 textarea 同字体/换行行为；scrollLeft/Top 同步）
 *      ├─ pre.ta-measure   隐形测量层（逐逻辑行 <span>，读 offsetTop 得逻辑行首 y——软换行续行不占行号）
 *      └─ textarea         原节点（透明文字 caret 可见）
 *
 * 行号取舍：行号标注在【逻辑行】首（软换行续行向下排、顶格——textarea 无悬挂缩进）。
 */

const KW_RE = /^(sudo|systemctl|bash|sh|grep|awk|sed|cat|find|stat|openssl|apt-get|apt|ufw|ss|ps|tar|curl|jq|python3|fail2ban-client|date|cut|head|tail|xargs|echo|printf|test|mkdir|chmod|chown|ln|rm|cp|mv|install|nginx)\b/;

/** shell 高亮：{{NAME}} 琥珀 / 命令词紫 / 字符串绿 / 注释灰斜体。返回 HTML。 */
export function highlightShell(src) {
    const esc = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    let out = "", i = 0;
    while (i < src.length) {
        const rest = src.slice(i);
        let m;
        if ((m = rest.match(/^#[^\n]*/))) { out += `<span class="ta-cmt">${esc(m[0])}</span>`; i += m[0].length; continue; }
        if ((m = rest.match(/^'[^'\n]*'/)) || (m = rest.match(/^"[^"\n]*"/))) { out += `<span class="ta-str">${esc(m[0])}</span>`; i += m[0].length; continue; }
        if ((m = rest.match(/^\{\{(\w+)\}\}/))) { out += `<span class="ta-var">${esc(m[0])}</span>`; i += m[0].length; continue; }
        if ((m = rest.match(/^[A-Za-z_][\w.-]*/))) {
            out += KW_RE.test(m[0]) ? `<span class="ta-kw">${esc(m[0])}</span>` : esc(m[0]);
            i += m[0].length; continue;
        }
        out += esc(src[i]); i += 1;
    }
    return out + "\n"; // 尾随换行：与 textarea 软换行末行对齐
}

const escapeTxt = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * @param {HTMLTextAreaElement} node
 * @param {{ text?: string, lineNumbers?: boolean, highlight?: string | ((s: string) => string) | null, autoGrow?: boolean, maxHeight?: number }} [params]
 */
export function enhance(node, params = {}) {
    let cur = { ...params };
    /** @type {any} */
    let box = null, gutter = null, hl = null, measure = null;
    let raf = 0;

    const lines = () => String(cur.text ?? node.value ?? "").split("\n");

    const build = () => {
        destroy();
        box = document.createElement("span");
        box.className = "ta-enhance";
        node.parentNode.insertBefore(box, node);
        if (cur.lineNumbers) {
            gutter = document.createElement("span");
            gutter.className = "ta-gutter";
            box.appendChild(gutter);
        }
        const edit = document.createElement("span");
        edit.className = "ta-edit";
        if (cur.highlight) {
            hl = document.createElement("pre");
            hl.className = "ta-hl";
            edit.appendChild(hl);
        }
        if (cur.lineNumbers) {
            measure = document.createElement("pre");
            measure.className = "ta-measure";
            edit.appendChild(measure);
        }
        edit.appendChild(node); // textarea 移入编辑区末层（文字透明由 CSS 承担）
        box.appendChild(edit);
        node.classList.add("ta-src");
        node.addEventListener("scroll", onScroll);
        node.addEventListener("input", onInput);
    };

    const renderHl = () => {
        if (!hl) return;
        const fn = typeof cur.highlight === "function" ? cur.highlight : cur.highlight === "shell" ? highlightShell : null;
        hl.innerHTML = fn ? fn(String(cur.text ?? node.value ?? "")) : "";
    };

    const renderGutter = () => {
        if (!gutter || !measure) return;
        const ls = lines();
        // 逐逻辑行 span → offsetTop 即各逻辑行首视觉行 y（测量层与 textarea 同宽/字体/换行）
        measure.innerHTML = ls.map(l => `<span class="ta-ln">${escapeTxt(l) || " "}</span>`).join("<br>");
        requestAnimationFrame(() => {
            if (!gutter || !measure) return;
            let html = "";
            measure.querySelectorAll(".ta-ln").forEach((sp, i) => {
                html += `<span class="ta-no" style="top:${/** @type {any} */(sp).offsetTop}px">${i + 1}</span>`;
            });
            gutter.innerHTML = html;
            applyScroll();
        });
    };

    const fit = () => {
        if (!cur.autoGrow) return;
        node.style.height = "auto";
        // +2 = 上下 border 补偿（border-box 下 clientHeight = height - border，少 2px 必出滚动条）
        node.style.height = `${Math.min(node.scrollHeight + 2, cur.maxHeight ?? 420)}px`;
    };

    const applyScroll = () => {
        if (hl) { hl.scrollTop = node.scrollTop; hl.scrollLeft = node.scrollLeft; }
        if (gutter) gutter.style.transform = `translateY(${-node.scrollTop}px)`;
    };

    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyScroll(); }); };
    const onInput = () => { fit(); };

    function destroy() {
        node.removeEventListener("scroll", onScroll);
        node.removeEventListener("input", onInput);
        node.classList.remove("ta-src");
        if (box?.parentNode) {
            box.parentNode.insertBefore(node, box);
            box.remove();
        }
        box = gutter = hl = measure = null;
    }

    build();
    renderHl();
    renderGutter();
    fit();
    applyScroll();

    return {
        update(next) {
            const structural = next.lineNumbers !== cur.lineNumbers
                || next.highlight !== cur.highlight
                || next.autoGrow !== cur.autoGrow
                || next.maxHeight !== cur.maxHeight;
            cur = { ...next };
            if (structural) { build(); renderHl(); renderGutter(); }
            else { renderHl(); renderGutter(); }
            fit();
            applyScroll();
        },
        destroy,
    };
}
