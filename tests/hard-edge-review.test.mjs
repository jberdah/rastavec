import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import init, { vectorize_rgba } from '../src/lib/engine/vtracer-next-wasm/vtracer_next.js'
const require = createRequire(new URL('../cli/package.json', import.meta.url))
const sharp = require('sharp')
const code = require('esbuild').buildSync({stdin:{contents:`export {vectorize,needsReviewResult} from './src/lib/engine/vectorize'; export {DEFAULT_PARAMS} from './src/lib/engine/presets'; export {withVTracerNext} from './src/lib/engine/vtracer-next-trace'; export {optionsFor} from './src/lib/engine/trace-options'; export {needsHardEdgeReview} from './src/lib/engine/hard-edge-review';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'}).outputFiles[0].text
const {vectorize,needsReviewResult,DEFAULT_PARAMS,withVTracerNext,optionsFor,needsHardEdgeReview} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
await init({module_or_path:await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm',import.meta.url))})
const backend = withVTracerNext({async rasterize(svg,width,height){return {width,height,data:new Uint8ClampedArray(await sharp(Buffer.from(svg)).resize(width,height).ensureAlpha().raw().toBuffer())}}},false,async(src,p,b,g)=>vectorize_rgba(new Uint8Array(src.data),src.width,src.height,{...optionsFor(p,b),experimentalGradients:g}),()=>{throw Error('unexpected binary')})
const settings={presetId:'auto',params:DEFAULT_PARAMS,auto:{enabled:true,threshold:3,maxKB:400}}
async function decode(file){const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {width:info.width,height:info.height,data:new Uint8ClampedArray(data)}}
test('Auto recovers thin hamster details with one bounded native trial, preserving existing sprite/soft routes',async()=>{
 for(const [file,rescue] of [['grouping-corpus/hamster-sheet',true],['pixel-art/owl-sheet',false],['pixel-art/tiny-wizard',false],['grouping-corpus/kenney-bear',false],['grouping-corpus/bat',false]]){
 const src=await decode(`tests/fixtures/${file}.png`),r=await vectorize(src,settings,backend),chosen=r.trials[r.chosen];
 assert.equal(r.trials.filter(t=>t.params.mode==='none' && !t.traceMethod).length,rescue?1:0,file)
 if(rescue){assert.equal(chosen.params.mode,'none');assert.equal(chosen.metrics.pctDiff,0);assert.equal(chosen.metrics.alphaDiff,0);assert.equal(chosen.metrics.iou,1);assert.ok(chosen.metrics.bytes<400*1024);assert.ok(chosen.metrics.paths<1500)}
 else assert.ok(chosen.metrics.pctDiff<3,file)
 console.log(file,JSON.stringify({chosen:chosen.metrics,mode:chosen.params.mode,ms:chosen.ms}))
 }
})
test('hard-edge recovery rejects fractional alpha and opaque gradients',()=>{
 const width=64,height=32,data=new Uint8ClampedArray(width*height*4)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set([x*4,y*8,100,255],(y*width+x)*4)
 assert.equal(needsHardEdgeReview({width,height,data}),false)
 data.fill(0);for(let i=0;i<data.length/2;i+=4)data.set([20,40,60,128],i)
 assert.equal(needsHardEdgeReview({width,height,data}),false)
})


test('rescue treats the size cap as a review target and survives optional tracing failure',async()=>{
 const src=await decode('tests/fixtures/grouping-corpus/hamster-sheet.png')
 const capped=await vectorize(src,{...settings,auto:{...settings.auto,maxKB:30}},backend)
 const cappedChosen=capped.trials[capped.chosen]
 assert.equal(cappedChosen.params.mode,'none')
 assert.ok(cappedChosen.metrics.bytes>30*1024)
 assert.equal(needsReviewResult(capped,{...settings.auto,maxKB:30}),true)
 const failing={...backend,async traceColorSource(src,p){if(p.mode==='none')throw Error('recovery unavailable');return backend.traceColorSource(src,p)}}
 const recovered=await vectorize(src,settings,failing)
 assert.equal(recovered.failedTrials.length,1)
 assert.match(recovered.failedTrials[0].message,/recovery unavailable/)
 assert.ok(recovered.trials[recovered.chosen].metrics.pctDiff<21)
})
