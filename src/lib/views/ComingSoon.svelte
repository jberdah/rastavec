<script lang="ts">
  import { go } from '../store.svelte'
  let { kind }: { kind: string } = $props()
  const art: Record<string, string> = { edit: '/brand/mascot-laptop.webp', animate: '/brand/mascot-idea.webp' }
  const copy: Record<string, { title: string; text: string }> = {
    edit: { title: 'Éditer les couleurs', text: 'Palette extraite du SVG, fusion des teintes proches, déclinaisons et application à tout le lot. Prochaine étape du POC.' },
    animate: { title: 'Animer', text: 'Calques, pivots et timeline façon Flash, exports SVG animé respectant le mouvement réduit. Prochaine étape du POC.' },
  }
  const c = $derived(copy[kind] ?? copy.edit)
</script>

<div class="soon">
<img src={art[kind] ?? art.edit} alt="" width="220" height="220" />
<div class="card stack" style="max-width: 640px">
  <span class="chip chip-muted" style="align-self: flex-start">Bientôt</span>
  <h1>{c.title}</h1>
  <p class="muted">{c.text}</p>
  <button type="button" class="btn" style="align-self: flex-start" onclick={() => go('lot')}>Revenir au lot</button>
</div>
</div>

<style>
  .soon { display: flex; flex-wrap: wrap; align-items: center; gap: 28px; }
  .soon img { width: 200px; height: auto; }
</style>
