<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '../store.svelte'
  import { i18n } from '../i18n.svelte'
  import { captureSession, deleteSession, loadSession, restoreSession, saveSession, type SessionRecord } from '../session'

  let phase = $state<'loading' | 'choice' | 'ready' | 'restoring' | 'unavailable'>('loading')
  let saved = $state<SessionRecord | undefined>()
  let status = $state<'idle' | 'waiting' | 'saving' | 'saved' | 'error'>('idle')
  let error = $state('')
  let sequence = 0
  let writes: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined

  const messages = $derived(i18n.locale === 'fr' ? {
    loading: 'Recherche d’une sauvegarde locale…',
    choice: 'Une session sauvegardée est disponible sur cet appareil.',
    privacy: 'Images et SVG sont conservés dans ce profil de navigateur jusqu’à suppression ; ils ne sont pas envoyés.',
    date: 'Dernière sauvegarde', restore: 'Reprendre la session', continue: 'Nouveau lot (remplacera la sauvegarde)',
    busy: 'Restauration…', waiting: 'Modifications en attente de sauvegarde', saving: 'Sauvegarde locale en cours…',
    saved: 'Session sauvegardée sur cet appareil', failed: 'Sauvegarde locale indisponible',
    delete: 'Effacer la sauvegarde locale', confirm: 'Effacer la sauvegarde locale ? Le lot ouvert ne sera pas supprimé.',
    conflict: 'Videz le lot actuel avant de reprendre la sauvegarde.',
  } : {
    loading: 'Looking for a local saved session…',
    choice: 'A saved session is available on this device.',
    privacy: 'Images and SVGs are kept in this browser profile until deleted; they are not uploaded.',
    date: 'Last saved', restore: 'Restore session', continue: 'New batch (replaces this backup)',
    busy: 'Restoring…', waiting: 'Changes waiting to be saved', saving: 'Saving locally…',
    saved: 'Session saved on this device', failed: 'Local session storage unavailable',
    delete: 'Delete local backup', confirm: 'Delete the local backup? The open batch will not be removed.',
    conflict: 'Clear the current batch before restoring the backup.',
  })

  onMount(() => {
    void loadSession().then((record) => {
      saved = record
      phase = record ? 'choice' : 'ready'
    }).catch((e) => { error = String(e); status = 'error'; phase = 'unavailable' })
  })

  // Capture immutable data while tracking all reactive fields. The File and large SVG
  // payloads are written only after the debounce; writes are serialized and transactional.
  $effect(() => {
    if (phase !== 'ready' || app.running || !app.items.length) return
    const snapshot = captureSession()
    const current = ++sequence
    status = 'waiting'
    timer = setTimeout(() => {
      status = 'saving'
      writes = writes.catch(() => {}).then(async () => {
        if (current !== sequence || phase !== 'ready') return
        await saveSession(snapshot)
        if (current === sequence) { saved = snapshot; status = 'saved'; error = '' }
      }).catch((e) => { if (current === sequence) { status = 'error'; error = String(e) } })
    }, 1200)
    return () => { if (timer) clearTimeout(timer) }
  })

  async function restore() {
    if (!saved) return
    phase = 'restoring'
    try { await restoreSession(saved); phase = 'ready'; status = 'saved'; error = '' }
    catch (e) { phase = 'choice'; status = 'error'; error = String(e) }
  }

  async function remove() {
    if (!confirm(messages.confirm)) return
    sequence++
    if (timer) clearTimeout(timer)
    try {
      await writes
      await deleteSession()
      saved = undefined
      status = 'idle'; error = ''
      // Keep saving the currently open batch on subsequent changes.
      phase = 'ready'
    } catch (e) { status = 'error'; error = String(e) }
  }
</script>

{#if phase === 'loading'}
  <aside class="session" aria-live="polite">{messages.loading}</aside>
{:else if phase === 'choice' || phase === 'restoring'}
  <aside class="session" aria-label={messages.choice}>
    <div class="copy">
      <strong>{messages.choice}</strong>
      {#if saved?.savedAt}<span>{messages.date} : {new Date(saved.savedAt).toLocaleString(i18n.locale)}</span>{/if}
      <span>{messages.privacy}</span>
      {#if app.items.length}<span>{messages.conflict}</span>{/if}
      {#if error}<span role="alert">{messages.failed} : {error}</span>{/if}
    </div>
    <div class="actions">
      <button type="button" class="btn btn-primary" disabled={phase === 'restoring' || app.items.length > 0 || app.running} onclick={restore}>{phase === 'restoring' ? messages.busy : messages.restore}</button>
      <button type="button" class="btn" disabled={phase === 'restoring'} onclick={() => { phase = 'ready'; status = 'idle' }}>{messages.continue}</button>
      <button type="button" class="btn" disabled={phase === 'restoring'} onclick={remove}>{messages.delete}</button>
    </div>
  </aside>
{:else if phase === 'unavailable' || app.items.length || saved}
  <aside class="session compact" aria-live="polite">
    <div class="copy">
      {#if status === 'waiting' || app.running}<span>{messages.waiting}</span>
      {:else if status === 'saving'}<span>{messages.saving}</span>
      {:else if status === 'saved'}<span>{messages.saved}</span>
      {:else if status === 'error' || phase === 'unavailable'}<span role="alert">{messages.failed} : {error}</span>{/if}
      <span>{messages.privacy}</span>
    </div>
    {#if saved && phase !== 'unavailable'}<button type="button" class="btn" onclick={remove}>{messages.delete}</button>{/if}
  </aside>
{/if}

<style>
  .session { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px var(--page-pad); background: var(--surface); border-bottom: 1px solid var(--line); font-size: 13px; }
  .copy { display: flex; flex-wrap: wrap; flex-direction: column; gap: 4px; color: var(--muted); }
  .copy strong { color: var(--text); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .compact { padding-top: 8px; padding-bottom: 8px; }
</style>
