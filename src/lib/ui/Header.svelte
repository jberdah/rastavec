<script lang="ts">
  import { app, doneItems, go, type Route } from '../store.svelte'
  import { i18n, LOCALES, setLocale, t } from '../i18n.svelte'

  const steps: { id: Route; key: 'nav.import' | 'nav.lot' | 'nav.detail' | 'nav.edit' | 'nav.animate' }[] = [
    { id: 'import', key: 'nav.import' },
    { id: 'lot', key: 'nav.lot' },
    { id: 'detail', key: 'nav.detail' },
    { id: 'edit', key: 'nav.edit' },
    { id: 'animate', key: 'nav.animate' },
  ]
  const enabled = (id: Route) =>
    id === 'import' || id === 'edit' || id === 'animate' || (id === 'lot' ? app.items.length > 0 : doneItems().length > 0)
</script>

<header class="bar">
  <div class="brand">
    <img class="logo" src="/brand/logo-48.webp" srcset="/brand/logo-48.webp 1x, /brand/logo-96.webp 2x" alt="RastaVec" width="229" height="48" />
  </div>
  <nav class="seg strong" aria-label={t('nav.steps')}>
    {#each steps as s (s.id)}
      <button type="button" aria-pressed={app.route === s.id} disabled={!enabled(s.id)} onclick={() => go(s.id)}>{t(s.key)}</button>
    {/each}
  </nav>
  <div class="right">
    <div class="privacy">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      {t('privacy')}
    </div>
    <div class="seg lang" role="group" aria-label={t('nav.language')}>
      {#each LOCALES as l (l.id)}
        <button type="button" lang={l.id} aria-pressed={i18n.locale === l.id} onclick={() => setLocale(l.id)}>{l.label}</button>
      {/each}
    </div>
  </div>
</header>

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 16px var(--page-pad); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; background: rgba(10, 11, 15, 0.88); backdrop-filter: blur(10px); }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { display: block; height: 36px; width: auto; }
  .right { display: flex; align-items: center; gap: 14px; }
  .privacy { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .lang button { min-height: 32px; padding: 0 10px; font-size: 12px; font-weight: 600; }
  @media (max-width: 640px) { .bar { padding-top: 12px; padding-bottom: 12px; position: static; } }
</style>
