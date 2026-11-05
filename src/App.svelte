<script lang="ts">
  import Header from './lib/ui/Header.svelte'
  import ImportView from './lib/views/ImportView.svelte'
  import LotView from './lib/views/LotView.svelte'
  import DetailView from './lib/views/DetailView.svelte'
  import EditView from './lib/views/EditView.svelte'
  import ComingSoon from './lib/views/ComingSoon.svelte'
  import { app } from './lib/store.svelte'
</script>

<Header />
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
