<script>
  /** 运行任务弹窗：自持 dry-run/PROD 确认输入；确认后回调 { dryRun, prodVal }。 */
  let { label, needProd, displayName, onrun, oncancel } = $props();
  let dryRun = $state(false);
  let prodVal = $state("");
</script>

<div class="overlay">
  <div class="modal">
    <h3>运行 {label}</h3>
    <label class="mut"><input type="checkbox" bind:checked={dryRun} /> dry-run（只打印计划，不产生副作用）</label>
    {#if needProd && !dryRun}
      <label style="color:var(--err)">PROD：输入显示名 <b>{displayName}</b> 确认<input bind:value={prodVal} placeholder={displayName} /></label>
    {/if}
    <div class="row">
      <button class="primary" onclick={() => onrun?.({ dryRun, prodVal })}>运行</button>
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
  .mut { display: flex; gap: 6px; align-items: center; font-size: 13px; }
  .mut input { width: auto; }
</style>
