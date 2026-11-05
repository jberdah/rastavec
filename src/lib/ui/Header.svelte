<script lang="ts">
  import { app, doneItems, go, type Route } from '../store.svelte'

  const steps: { id: Route; label: string }[] = [
    { id: 'import', label: '1 Importer' },
    { id: 'lot', label: '2 Revue du lot' },
    { id: 'detail', label: '3 Détail' },
    { id: 'edit', label: '4 Éditer' },
    { id: 'animate', label: '5 Animer' },
  ]
  const enabled = (id: Route) =>
    id === 'import' || id === 'edit' || id === 'animate' || (id === 'lot' ? app.items.length > 0 : doneItems().length > 0)
</script>

<header class="bar">
  <div class="brand">
    <img class="logo" src="/brand/logo-48.webp" srcset="/brand/logo-48.webp 1x, /brand/logo-96.webp 2x" alt="RastaVec" width="229" height="48" />
  </div>
  <nav class="seg strong" aria-label="Étapes">
    {#each steps as s (s.id)}
      <button type="button" aria-pressed={app.route === s.id} disabled={!enabled(s.id)} onclick={() => go(s.id)}>{s.label}</button>
    {/each}
  </nav>
  <div class="privacy">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
    100 % local — rien n'est envoyé
  </div>
</header>

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 32px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; background: rgba(10, 11, 15, 0.88); backdrop-filter: blur(10px); }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { display: block; height: 36px; width: auto; }
  .privacy { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  @media (max-width: 640px) { .bar { padding: 12px 16px; position: static; } }
</style>
