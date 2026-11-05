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
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><path d="M4 24 C 8 6, 22 6, 26 24" fill="none" stroke="#C8F65A" stroke-width="2.2" stroke-linecap="round" /><line x1="4" y1="24" x2="10" y2="8" stroke="#5B6472" stroke-width="1.2" /><line x1="26" y1="24" x2="20" y2="8" stroke="#5B6472" stroke-width="1.2" /><rect x="1.5" y="21.5" width="5" height="5" fill="#0A0B0F" stroke="#C8F65A" stroke-width="1.5" /><rect x="23.5" y="21.5" width="5" height="5" fill="#0A0B0F" stroke="#C8F65A" stroke-width="1.5" /><circle cx="10" cy="8" r="2" fill="#5B6472" /><circle cx="20" cy="8" r="2" fill="#5B6472" /></svg>
    <span class="name">RastaVec</span>
    <span class="tag mono">POC</span>
  </div>
  <nav class="seg strong" aria-label="Étapes">
    {#each steps as s (s.id)}
      <button type="button" aria-pressed={app.route === s.id} disabled={!enabled(s.id)} onclick={() => go(s.id)}>{s.label}</button>
    {/each}
  </nav>
  <div class="privacy">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C8F65A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
    100 % local — rien n'est envoyé
  </div>
</header>

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 32px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; background: rgba(10, 11, 15, 0.88); backdrop-filter: blur(10px); }
  .brand { display: flex; align-items: center; gap: 12px; }
  .name { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .tag { font-size: 12px; color: var(--muted); border: 1px solid var(--line-2); border-radius: 6px; padding: 3px 8px; }
  .privacy { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  @media (max-width: 640px) { .bar { padding: 12px 16px; position: static; } }
</style>
