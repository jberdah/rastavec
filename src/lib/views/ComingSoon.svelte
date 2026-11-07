<script lang="ts">
  import { go } from '../store.svelte'
  import { t } from '../i18n.svelte'
  import { publicAsset } from '../assets'
  let { kind }: { kind: string } = $props()
  const art: Record<string, string> = { edit: 'mascot-laptop.webp', animate: 'mascot-idea.webp' }
  const isAnimate = $derived(kind === 'animate')
</script>

<div class="soon">
  <img src={publicAsset('brand/' + (art[kind] ?? art.edit))} alt="" width="220" height="220" />
  <div class="card stack" style="max-width: 640px">
    <span class="chip chip-muted" style="align-self: flex-start">{t('soon.badge')}</span>
    <h1>{isAnimate ? t('soon.animate.title') : t('soon.edit.title')}</h1>
    <p class="muted">{isAnimate ? t('soon.animate.text') : t('soon.edit.text')}</p>
    <button type="button" class="btn" style="align-self: flex-start" onclick={() => go('lot')}>{t('soon.back')}</button>
  </div>
</div>

<style>
  .soon { display: flex; flex-wrap: wrap; align-items: center; gap: 28px; }
  .soon img { width: 200px; height: auto; }
</style>
