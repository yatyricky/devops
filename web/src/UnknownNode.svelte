<script>
  /** 未知类型节点：红框空卡（只读）。标题 = 节点 id，正文 = 原始 JSON。
   *  加载时未知 type 改写为 unknown 渲染（原类型存 data.__origType，保存时还原）；不可运行由运行前校验拦。 */
  let { id, data } = $props();
  const origType = data?.__origType ?? "未知类型";
  const json = JSON.stringify(data ?? {}, null, 2);
</script>

<div class="unknown-node nodrag">
  <div class="uhead">⚠ {id}<span class="utype">{origType}</span></div>
  <textarea class="ujson" readonly value={json} rows={Math.min(14, json.split("\n").length)}></textarea>
</div>

<style>
  .unknown-node { width: 320px; border: 1.5px solid var(--err); border-radius: 8px;
    background: color-mix(in srgb, var(--err) 8%, var(--panel)); overflow: hidden; }
  .uhead { display: flex; align-items: center; gap: 6px; padding: 4px 10px;
    background: color-mix(in srgb, var(--err) 25%, var(--panel)); color: var(--err);
    font-weight: 600; font-size: 12px; }
  .utype { margin-left: auto; font-size: 10px; font-weight: 400; color: var(--dim); }
  .ujson { display: block; width: 100%; border: none; resize: vertical;
    background: transparent; color: var(--dim); font: 10px/1.5 var(--mono, Consolas, monospace);
    padding: 4px 8px; }
</style>
