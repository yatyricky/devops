<script>
  /** 打开/新建工作流弹窗：自持输入态；确认后回调 { mode, path, title }（路径校验在后端）。 */
  let { mode, onconfirm, oncancel } = $props();
  let path = $state("");
  let title = $state("");
</script>

<!-- 关闭只走显式按钮；点背景不关闭，防长表单误触丢内容 -->
<div class="overlay">
  <div class="modal">
    <h3>{mode === "new" ? "新建工作流" : "打开工作流"}</h3>
    {#if mode === "new"}
      <label>显示名（别名，可留空 = 用文件名）<input bind:value={title} placeholder="我的部署流程" /></label>
    {/if}
    <label>JSON 文件完整路径（可在磁盘任意位置）<input class="mono" bind:value={path} placeholder="C:/Users/yatyr/workspace/devops/workflows/my-app.json" /></label>
    <div class="row">
      <button class="primary" onclick={() => onconfirm?.({ mode, path, title })}>{mode === "new" ? "创建" : "打开"}</button>
      <button onclick={() => oncancel?.()}>取消</button>
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(4, 8, 14, .66); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; width: min(520px, 92vw); }
  .modal h3 { margin: 0 0 10px; font-size: 15px; }
  .modal label { display: block; margin: 8px 0; font-size: 13px; }
  .modal label input[type="text"], .modal label input:not([type]) { display: block; margin-top: 3px; }
  .modal .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .mono { font-family: var(--mono); }
</style>
