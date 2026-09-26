<script>
  /** 画布拖放落点：把 HTML5 拖放的 client 坐标转成流坐标并回调（需在 SvelteFlow 上下文内） */
  import { useSvelteFlow } from "@xyflow/svelte";
  import { onMount } from "svelte";

  let { ondropat } = $props();
  const { screenToFlowPosition } = useSvelteFlow();

  onMount(() => {
    const pane = document.querySelector(".svelte-flow__pane");
    if (!pane) return;
    const allow = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; };
    const drop = (e) => {
      e.preventDefault();
      const type = e.dataTransfer?.getData("application/x-devops-node");
      if (!type) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      ondropat?.(type, pos);
    };
    pane.addEventListener("dragover", allow);
    pane.addEventListener("drop", drop);
    return () => { pane.removeEventListener("dragover", allow); pane.removeEventListener("drop", drop); };
  });
</script>
