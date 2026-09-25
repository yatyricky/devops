<script>
  /** 底部日志抽屉：SSE-over-POST 流式 + 轮询兜底；follow() 供 App 调用。 */
  import { streamJob } from "./api.js";
  import { ansiToHtml } from "./ansi.js";

  let open = $state(false);
  let title = $state("-");
  let status = $state("-");
  /** @type {{raw: string, html: string}[]} */
  let lines = $state([]);
  let box = $state(null);

  /** @param {string} msg */
  function append(msg) {
    // ANSI 染色在入列时转换一次（行数多时避免重复解析）
    lines.push({ raw: String(msg), html: ansiToHtml(msg) });
    if (box) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }

  /**
   * 跟踪一个任务到终态。
   * @param {string} id
   * @param {string} t
   * @param {(nodeStatus: Record<string,string> | null) => void} [onNode] 节点执行状态回调（卡片外框）
   */
  export async function follow(id, t, onNode) {
    title = t; lines.length = 0; status = "运行中"; open = true;
    await streamJob(id, {
      log: append,
      status: (st, err) => { status = (st === "ok" ? "成功" : st === "failed" ? "失败" : st); if (err) append(`[Failed] ${err}`); },
      node: ns => onNode?.(ns),
      end: () => {},
    });
    if (status !== "失败") append("[Done] 任务结束");
  }
</script>

{#if open}
  <div class="logpanel">
    <div class="bar">
      <span class="t">{title}</span>
      <span class="st {(status === '成功') ? 'ok' : (status === '失败') ? 'failed' : ''}">{status}</span>
      <button style="margin-left:auto" onclick={() => (open = false)}>关闭</button>
    </div>
    <div class="lines" bind:this={box}>
      {#each lines as l}
        <div class:l-err={/\[(ERROR|Failed|WARN)/.test(l.raw)}>{@html l.html}</div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .logpanel { height: 38vh; min-height: 160px; background: var(--panel); border-top: 1px solid var(--line);
    display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 5px 14px; border-bottom: 1px solid var(--line); }
  .t { font-weight: 600; font-size: 13px; }
  .st { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 10px; }
  .st.ok { color: var(--ok); border-color: var(--ok); }
  .st.failed { color: var(--err); border-color: var(--err); }
  .lines { flex: 1; overflow: auto; padding: 8px 14px; font: 12px/1.5 Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
  .l-err { color: var(--err); }
</style>
