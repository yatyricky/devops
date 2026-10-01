<script>
  /**
   * 三态轨道开关（struct boolean 字段值 / boolean widget / taskbar 开关共用）。
   * 外观：value===undefined → 空轨（无滑块、暗色）；false → 暗滑块居左；true → accent 滑块居右。
   * tri=true 点击循环 true→false→undefined→true（真三态）；默认二态 true↔false（undefined 视同 false）。
   */
  let { value, tri = false, onchange, class: cls = "" } = $props();
  function click() {
    if (!onchange) return;
    onchange(tri ? (value === true ? false : value === false ? undefined : true) : !(value === true));
  }
</script>

<button type="button" role="switch" class="tri-switch {cls}" class:on={value === true} class:unset={value === undefined}
  aria-checked={value === true}
  title={value === true ? "true（点击关闭）" : value === false ? "false（点击开启）" : "未设置（点击开启）"}
  onclick={click}><span class="knob"></span></button>

<style>
  .tri-switch { position: relative; display: inline-block; width: 34px; height: 18px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--panel2); cursor: pointer; padding: 0;
    vertical-align: middle; flex: none; transition: background .15s, border-color .15s; }
  .tri-switch .knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
    border-radius: 50%; background: var(--dim); transition: left .15s, background .15s; }
  .tri-switch.unset .knob { display: none; }
  .tri-switch.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 30%, var(--panel2)); }
  .tri-switch.on .knob { left: 18px; background: var(--accent); }
  .tri-switch:focus-visible { outline: 1px solid var(--accent); }
</style>
