/**
 * textarea 增强action：行号（逻辑行）/ 语法高亮 overlay——任意 textarea 用
 * use:enhance={{ text, lineNumbers, highlight, height }} 选择性应用，destroy 完整还原。
 *
 * 结构（action 自管，包一层 .ta-enhance 容器）：
 *   .ta-enhance
 *   ├─ .ta-gutter          行号列（定宽，overflow hidden，行号 span 绝对定位按逻辑行首视觉行 y）
 *   └─ .ta-edit            相对定位编辑区
 *      ├─ pre.ta-hl        高亮层（与 textarea 同字体/换行行为；scrollLeft/Top 同步）
 *      ├─ pre.ta-measure   隐形测量层（逐逻辑行 <span>，读 offsetTop 得逻辑行首 y——软换行续行不占行号）
 *      └─ textarea         原节点（透明文字 caret 可见；高度用户手动拖，params.height 作初始值）
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
 * @param {{ text?: string, lineNumbers?: boolean, highlight?: string | ((s: string) => string) | null, height?: number }} [params]
 */
export function enhance(node, params = {}) {
    let cur = { ...params };
    /** @type {any} */
    let box = null, gutter = null, gutterInner = null, hl = null, measure = null;
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
            // 行号在 inner 层滚动（translateY）；gutter 框固定不动，overflow:hidden 才能裁住滚出的行号
            gutterInner = document.createElement("span");
            gutterInner.className = "ta-gutter-inner";
            gutter.appendChild(gutterInner);
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
        // 高度：params.height（序列化的用户拖拽值）作初始；之后由用户手动拖，action 不干预
        if (cur.height) node.style.height = `${cur.height}px`;
        node.addEventListener("scroll", onScroll);
    };

    const renderHl = () => {
        if (!hl) return;
        const fn = typeof cur.highlight === "function" ? cur.highlight : cur.highlight === "shell" ? highlightShell : null;
        hl.innerHTML = fn ? fn(String(cur.text ?? node.value ?? "")) : "";
    };

    const renderGutter = () => {
        if (!gutter || !measure || !gutterInner) return;
        const ls = lines();
        // 逐逻辑行 span → offsetTop 即各逻辑行首视觉行 y（测量层与 textarea 同宽/字体/换行）
        measure.innerHTML = ls.map(l => `<span class="ta-ln">${escapeTxt(l) || " "}</span>`).join("<br>");
        requestAnimationFrame(() => {
            if (!gutterInner || !measure) return;
            let html = "";
            measure.querySelectorAll(".ta-ln").forEach((sp, i) => {
                html += `<span class="ta-no" style="top:${/** @type {any} */(sp).offsetTop}px">${i + 1}</span>`;
            });
            gutterInner.innerHTML = html;
            applyScroll();
        });
    };

    const applyScroll = () => {
        if (hl) { hl.scrollTop = node.scrollTop; hl.scrollLeft = node.scrollLeft; }
        if (gutterInner) gutterInner.style.transform = `translateY(${-node.scrollTop}px)`;
    };

    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; applyScroll(); }); };

    function destroy() {
        node.removeEventListener("scroll", onScroll);
        node.classList.remove("ta-src");
        node.style.height = ""; // 还原（rows 属性接管）
        if (box?.parentNode) {
            box.parentNode.insertBefore(node, box);
            box.remove();
        }
        box = gutter = gutterInner = hl = measure = null;
    }

    build();
    renderHl();
    renderGutter();
    applyScroll();

    return {
        update(next) {
            const structural = next.lineNumbers !== cur.lineNumbers || next.highlight !== cur.highlight;
            // update 永不碰高度：高度只在 mount 时由 params.height（uiH）设定，之后用户拖拽主导——
            // 重渲染（输入/图状态变化）时按旧 uiH 重设会弹回用户刚拖到的高度
            cur = { ...next };
            if (structural) { build(); renderHl(); renderGutter(); if (cur.height) node.style.height = `${cur.height}px`; }
            renderHl();
            renderGutter();
            applyScroll();
        },
        destroy,
    };
}
