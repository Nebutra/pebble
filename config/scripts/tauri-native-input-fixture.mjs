export function nativeInputFixtureHtml(frameUrl) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Pebble trusted input fixture</title>
<style>
body{margin:0;padding:24px;background:#e8f3ed;color:#18352a;font:16px system-ui}
main{display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:16px;max-width:900px}
.target{box-sizing:border-box;min-height:72px;padding:16px;border:2px solid #18352a;background:#fff}
#wheel-target{height:120px;overflow:auto}#wheel-content{height:500px}
#drag-source,#drop-target{height:80px}iframe{width:420px;height:180px;border:2px solid #18352a}
</style></head><body><main>
<button class="target" id="mouse-target">Mouse target</button>
<input class="target" id="text-target" value="replace me" aria-label="Text target">
<input class="target" id="key-target" aria-label="Key target">
<div class="target" id="wheel-target"><div id="wheel-content">Wheel target</div></div>
<div class="target" id="drag-source" draggable="true">Drag source</div>
<div class="target" id="drop-target">Drop target</div>
<label class="target"><input id="check-target" type="checkbox"> Trusted checkbox</label>
<label class="target">Trusted select<select id="select-target"><option value="alpha">Alpha</option><option value="beta">Beta</option></select></label>
<iframe id="same-origin-frame" src=${JSON.stringify(frameUrl)}></iframe>
</main><script>
(()=>{
  const events=[];const state={mouseClicks:0,dropped:false};
  const record=(label,event)=>events.push({label,type:event.type,trusted:event.isTrusted,key:event.key||null});
  const watch=(selector,types)=>{const node=document.querySelector(selector);for(const type of types)node.addEventListener(type,(event)=>record(selector,event),true)};
  watch('#mouse-target',['mousemove','mousedown','mouseup','click']);
  watch('#text-target',['beforeinput','input','change']);
  watch('#key-target',['keydown','keyup','beforeinput','input']);
  watch('#wheel-target',['wheel','scroll']);
  watch('#drag-source',['mousedown','dragstart','dragend']);
  watch('#drop-target',['dragenter','dragover','drop']);
  watch('#check-target',['mousedown','mouseup','click','input','change']);
  watch('#select-target',['keydown','keyup','input','change']);
  document.querySelector('#mouse-target').addEventListener('click',()=>state.mouseClicks++);
  document.querySelector('#drop-target').addEventListener('dragover',(event)=>event.preventDefault());
  document.querySelector('#drop-target').addEventListener('drop',(event)=>{event.preventDefault();state.dropped=true});
  globalThis.__pebbleRecordFrameInput=(label,event)=>record(label,event);
  globalThis.__pebbleNativeInputEvidence=()=>{
    const frame=document.querySelector('#same-origin-frame');
    let frameState=null;
    try{frameState=frame.contentWindow.__pebbleFrameInputEvidence?.()||null}catch{}
    return {events:[...events],mouseClicks:state.mouseClicks,textValue:document.querySelector('#text-target').value,
      keyValue:document.querySelector('#key-target').value,wheelTop:document.querySelector('#wheel-target').scrollTop,
      dropped:state.dropped,checked:document.querySelector('#check-target').checked,
      selected:document.querySelector('#select-target').value,frameState};
  };
  globalThis.__pebbleNativeInputReady=true;
})();
</script></body></html>`
}

export function nativeInputFrameFixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px}trusted-controls{display:block}</style></head>
<body><trusted-controls id="shadow-host"></trusted-controls><script>
(()=>{
  const host=document.querySelector('#shadow-host');const root=host.attachShadow({mode:'open'});
  root.innerHTML='<style>button,input{box-sizing:border-box;width:180px;height:52px;margin:8px}</style><button id="frame-button">Frame shadow button</button><input id="frame-input" value="old">';
  const state={clicks:0,events:[]};const record=(label,event)=>{state.events.push({label,type:event.type,trusted:event.isTrusted,key:event.key||null});parent.__pebbleRecordFrameInput?.(label,event)};
  const button=root.querySelector('#frame-button');const input=root.querySelector('#frame-input');
  for(const type of ['mousedown','mouseup','click'])button.addEventListener(type,(event)=>record('frame-button',event),true);
  for(const type of ['beforeinput','input','change'])input.addEventListener(type,(event)=>record('frame-input',event),true);
  button.addEventListener('click',()=>state.clicks++);
  globalThis.__pebbleFrameInputEvidence=()=>({clicks:state.clicks,inputValue:input.value,events:[...state.events]});
  globalThis.__pebbleFrameInputReady=true;
})();
</script></body></html>`
}
