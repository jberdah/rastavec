<script lang="ts">
  import Header from './lib/ui/Header.svelte'
  import SessionPanel from './lib/ui/SessionPanel.svelte'
  import ImportView from './lib/views/ImportView.svelte'
  import LotView from './lib/views/LotView.svelte'
  import DetailView from './lib/views/DetailView.svelte'
  import EditView from './lib/views/EditView.svelte'
  import ComingSoon from './lib/views/ComingSoon.svelte'
  import { app } from './lib/store.svelte'

  // A batch lives in memory, including edits made after an export.
  function warnBeforeLeaving(event: BeforeUnloadEvent) {
    if (!app.items.length) return
    event.preventDefault()
    event.returnValue = ''
  }
</script>

<svelte:window onbeforeunload={warnBeforeLeaving} />
<Header />
<SessionPanel />
<main class="page">
  {#if app.route === 'import'}
    <ImportView />
  {:else if app.route === 'lot'}
    <LotView />
  {:else if app.route === 'detail'}
    <DetailView />
  {:else if app.route === 'edit'}
    <EditView />
  {:else}
    <ComingSoon kind={app.route} />
  {/if}
</main>
