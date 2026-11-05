<script lang="ts">
  let { size = 30, wordmark = true }: { size?: number; wordmark?: boolean } = $props()
</script>

<span class="logo" style:--s={`${size}px`}>
  <!-- Brand symbol: a Bézier curve with its three anchor points. Works monochrome at 16 px. -->
  <svg class="symbol" viewBox="0 0 32 24" width={size * 1.33} height={size} aria-hidden="true">
    <path d="M5 19C6 4 26 4 27 19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
    <rect x="2" y="16" width="6" height="6" rx="1" fill="var(--bg)" stroke="currentColor" stroke-width="2" />
    <rect x="24" y="16" width="6" height="6" rx="1" fill="var(--bg)" stroke="currentColor" stroke-width="2" />
    <rect x="13" y="5" width="6" height="6" rx="1" fill="var(--bg)" stroke="currentColor" stroke-width="2" />
  </svg>
  {#if wordmark}
    <span class="word"><span class="rasta">Rasta</span><span class="vec">Vec</span></span>
  {/if}
</span>

<style>
  .logo { display: inline-flex; align-items: center; gap: calc(var(--s) * 0.3); color: var(--brand-green-on-dark); }
  .symbol { flex: none; }
  .word { font-size: calc(var(--s) * 0.72); font-weight: 800; letter-spacing: -0.03em; font-style: italic; transform: skewX(-4deg); line-height: 1; }
  .rasta { color: var(--brand-cream); }
  .vec { color: var(--brand-green-on-dark); }
</style>
