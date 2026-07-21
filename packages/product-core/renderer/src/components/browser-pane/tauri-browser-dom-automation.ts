import { TAURI_BROWSER_SELECTOR_ROUTING_RUNTIME } from './tauri-browser-selector-routing'

const MAX_AUTOMATION_TEXT = 1024 * 1024
const MAX_SCROLL_AMOUNT = 10_000
const MAX_MOUSE_COORDINATE = 100_000

export type TauriBrowserDomCommand =
  | 'snapshot'
  | 'resolvePoint'
  | 'resolveSelectOption'
  | 'readSelectValues'
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'type'
  | 'focus'
  | 'clear'
  | 'keypress'
  | 'keyDown'
  | 'keyUp'
  | 'scroll'
  | 'scrollIntoView'
  | 'select'
  | 'check'
  | 'hover'
  | 'selectAll'
  | 'drag'
  | 'upload'
  | 'get'
  | 'is'
  | 'find'
  | 'keyboardInsertText'
  | 'wait'
  | 'captureStart'
  | 'captureStop'
  | 'console'
  | 'network'
  | 'harStart'
  | 'harStop'
  | 'profilerStart'
  | 'profilerStop'
  | 'interceptEnable'
  | 'interceptDisable'
  | 'interceptList'
  | 'storageLocalGet'
  | 'storageLocalSet'
  | 'storageLocalClear'
  | 'storageSessionGet'
  | 'storageSessionSet'
  | 'storageSessionClear'
  | 'highlight'
  | 'mouseMove'
  | 'mouseDown'
  | 'mouseUp'
  | 'mouseClick'
  | 'mouseWheel'
  | 'clipboardRead'
  | 'clipboardWrite'
  | 'clipboardCopy'
  | 'clipboardPaste'
  | 'download'
  | 'geolocation'
  | 'setMedia'
  | 'pushState'
  | 'eval'

export function buildTauriBrowserDomAutomationScript(
  command: TauriBrowserDomCommand,
  payload: Record<string, unknown>
): string {
  const input = validateAutomationPayload(command, payload)
  return `(async function(){
    const input=${JSON.stringify(input)};
    const fail=(message)=>{throw new Error(message)};
    ${TAURI_BROWSER_SELECTOR_ROUTING_RUNTIME}
    const statusMatches=(status,pattern)=>{
      const value=Number(status)||0;
      if(/^\\dxx$/i.test(pattern)) return Math.floor(value/100)===Number(pattern[0]);
      const range=pattern.match(/^(\\d{3})-(\\d{3})$/);
      return range?value>=Number(range[1])&&value<=Number(range[2]):value===Number(pattern);
    };
    const emitInput=(node)=>{
      node.dispatchEvent(new Event('input',{bubbles:true}));
      node.dispatchEvent(new Event('change',{bubbles:true}));
    };
    const setText=(node,value)=>{
      if(isTag(node,'input')){
        const constructor=node.ownerDocument.defaultView?.HTMLInputElement;
        const setter=constructor&&Object.getOwnPropertyDescriptor(constructor.prototype,'value')?.set;
        if(!setter) fail('Browser input value setter is unavailable.');
        setter.call(node,value); emitInput(node); return;
      }
      if(isTag(node,'textarea')){
        const constructor=node.ownerDocument.defaultView?.HTMLTextAreaElement;
        const setter=constructor&&Object.getOwnPropertyDescriptor(constructor.prototype,'value')?.set;
        if(!setter) fail('Browser textarea value setter is unavailable.');
        setter.call(node,value); emitInput(node); return;
      }
      if(node.isContentEditable){node.textContent=value;emitInput(node);return;}
      fail('Browser element does not accept text.');
    };
    if(input.command==='clipboardRead'||input.command==='clipboardWrite'||input.command==='clipboardCopy'||input.command==='clipboardPaste'){
      if(!navigator.clipboard) fail('Browser clipboard access is unavailable for this page.');
      if(input.command==='clipboardRead') return {text:await navigator.clipboard.readText()};
      if(input.command==='clipboardWrite'){await navigator.clipboard.writeText(input.text);return {written:true};}
      if(input.command==='clipboardCopy'){
        const text=getSelection()?.toString()||'';
        if(!document.execCommand?.('copy')) await navigator.clipboard.writeText(text);
        return {copied:true,text};
      }
      const active=deepActiveElement();
      if(!isHtmlElement(active)) fail('No browser element is focused.');
      const text=await navigator.clipboard.readText();
      const previous=isTag(active,'input')||isTag(active,'textarea')?active.value:(active.textContent||'');
      setText(active,previous+text);return {pasted:true,textLength:text.length};
    }
    if(input.command==='download'){
      const node=resolveTarget(input.element); node.click(); return {clicked:input.element};
    }
    if(input.command==='geolocation'){
      let state=globalThis.__pebbleAutomationGeolocation;
      if(!state){
        state=globalThis.__pebbleAutomationGeolocation={position:null,watchers:new Map(),nextId:1};
        const geo=navigator.geolocation||{};
        geo.getCurrentPosition=(success,error)=>queueMicrotask(()=>state.position?success(state.position):error?.({code:2,message:'Position unavailable'}));
        geo.watchPosition=(success,error)=>{const id=state.nextId++;state.watchers.set(id,{success,error});queueMicrotask(()=>state.position?success(state.position):error?.({code:2,message:'Position unavailable'}));return id;};
        geo.clearWatch=(id)=>state.watchers.delete(id);
        Object.defineProperty(navigator,'geolocation',{configurable:true,value:geo});
      }
      const coords={latitude:input.latitude,longitude:input.longitude,accuracy:input.accuracy,altitude:null,altitudeAccuracy:null,heading:null,speed:null};
      state.position={coords,timestamp:Date.now()};
      for(const watcher of state.watchers.values()) queueMicrotask(()=>watcher.success(state.position));
      return {latitude:input.latitude,longitude:input.longitude,accuracy:input.accuracy};
    }
    if(input.command==='setMedia'){
      const root=document.documentElement;
      let state=globalThis.__pebbleAutomationMedia;
      if(!state){
        const original=window.matchMedia.bind(window);
        state=globalThis.__pebbleAutomationMedia={original,colorScheme:null,reducedMotion:null};
        window.matchMedia=(query)=>{
          const base=original(query); const normalized=String(query).toLowerCase();
          let forced=null;
          if(normalized.includes('prefers-color-scheme')) forced=normalized.includes(state.colorScheme||'__none__');
          if(normalized.includes('prefers-reduced-motion')) forced=normalized.includes(state.reducedMotion||'__none__');
          if(forced===null) return base;
          return {media:base.media,matches:forced,onchange:null,addListener:base.addListener?.bind(base),removeListener:base.removeListener?.bind(base),addEventListener:base.addEventListener.bind(base),removeEventListener:base.removeEventListener.bind(base),dispatchEvent:base.dispatchEvent.bind(base)};
        };
      }
      state.colorScheme=input.colorScheme; state.reducedMotion=input.reducedMotion;
      root.style.colorScheme=input.colorScheme==='no-preference'?'':input.colorScheme;
      let style=document.getElementById('pebble-reduced-motion-override');
      if(input.reducedMotion==='reduce'){
        if(!style){style=document.createElement('style');style.id='pebble-reduced-motion-override';document.head.appendChild(style);}
        style.textContent='*,*::before,*::after{scroll-behavior:auto!important;animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;}';
      }else{style?.remove();}
      window.dispatchEvent(new Event('pebble-media-emulation-changed'));
      return {colorScheme:input.colorScheme,reducedMotion:input.reducedMotion,scope:'document'};
    }
    if(input.command.startsWith('storage')){
      const storage=input.command.startsWith('storageLocal')?localStorage:sessionStorage;
      if(input.command.endsWith('Get')){
        if(input.key===null){const values={};for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key!==null) values[key]=storage.getItem(key);}return {values};}
        const value=storage.getItem(input.key); return {key:input.key,value};
      }
      if(input.command.endsWith('Set')){
        storage.setItem(input.key,input.value); return {key:input.key,value:input.value};
      }
      storage.clear(); return {cleared:true};
    }
    if(input.command==='mouseMove'||input.command==='mouseDown'||input.command==='mouseUp'||input.command==='mouseClick'||input.command==='mouseWheel'){
      const state=globalThis.__pebbleAutomationMouse||(globalThis.__pebbleAutomationMouse={x:0,y:0,button:'left'});
      if(input.command==='mouseMove'||input.command==='mouseClick'){state.x=input.x;state.y=input.y;}
      if(input.button) state.button=input.button;
      const buttonCode={left:0,middle:1,right:2}[state.button];
      const node=document.elementFromPoint(state.x,state.y)||document.body||document.documentElement;
      if(input.command==='mouseWheel'){
        node.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:state.x,clientY:state.y,deltaX:input.dx,deltaY:input.dy}));
        window.scrollBy({left:input.dx,top:input.dy,behavior:'auto'}); return {x:state.x,y:state.y,dx:input.dx,dy:input.dy};
      }
      const eventName=input.command==='mouseMove'?'mousemove':input.command==='mouseDown'?'mousedown':input.command==='mouseUp'?'mouseup':'click';
      const buttons=input.command==='mouseUp'?0:input.command==='mouseMove'?0:1<<buttonCode;
      node.dispatchEvent(new MouseEvent(eventName,{bubbles:true,cancelable:true,view:window,clientX:state.x,clientY:state.y,button:buttonCode,buttons,
        altKey:input.modifiers?.includes('Alt'),ctrlKey:input.modifiers?.includes('Control'),metaKey:input.modifiers?.includes('Meta'),shiftKey:input.modifiers?.includes('Shift')}));
      return {x:state.x,y:state.y,button:state.button};
    }
    if(input.command==='highlight'){
      const node=resolveTarget(input.selector);
      if(!isHtmlElement(node)) fail('Browser highlight target was not found.');
      const previous=node.style.outline; const token=Math.random().toString(36).slice(2);
      node.dataset.pebbleAutomationHighlight=token; node.style.outline='2px solid #ff5a36';
      setTimeout(()=>{if(node.dataset.pebbleAutomationHighlight===token){node.style.outline=previous;delete node.dataset.pebbleAutomationHighlight;}},2000);
      return {highlighted:input.selector};
    }
    if(input.command==='captureStart'||input.command==='captureStop'||input.command==='console'||input.command==='network'){
      const capture=globalThis.__pebbleAutomationCapture;
      if(!capture) fail('Browser capture hooks are not available on this page. Reload and retry.');
      if(input.command==='captureStart'){
        capture.console.length=0; capture.network.length=0; capture.active=true;
        return {capturing:true};
      }
      if(input.command==='captureStop'){capture.active=false;return {stopped:true};}
      const source=input.command==='console'?capture.console:capture.network;
      if(input.command==='network'&&input.requestId!==null){
        const entry=source.find((candidate)=>candidate?.id===input.requestId);
        if(!entry) fail('Browser network request was not found.');
        return {request:entry};
      }
      if(input.clear){source.length=0;return {entries:[],cleared:true,truncated:false};}
      const filtered=source.filter((entry)=>{
        if(input.errorsOnly&&entry?.level!=='error') return false;
        if(input.filter&&!String(entry?.url||'').includes(input.filter)) return false;
        if(input.types?.length&&!input.types.includes(entry?.resourceType)) return false;
        if(input.method&&String(entry?.method||'').toUpperCase()!==input.method) return false;
        if(input.status&&!statusMatches(entry?.status,input.status)) return false;
        return true;
      });
      return {entries:filtered.slice(-input.limit),truncated:filtered.length>input.limit};
    }
    if(input.command==='harStart'||input.command==='harStop'){
      const capture=globalThis.__pebbleAutomationCapture;
      if(!capture) fail('Browser capture hooks are not available on this page. Reload and retry.');
      if(input.command==='harStart'){
        capture.network.length=0; capture.harStartedAt=Date.now(); return {recording:true};
      }
      const startedAt=capture.harStartedAt;
      if(!startedAt) fail('Browser HAR recording has not started.');
      capture.harStartedAt=null;
      const entries=capture.network.map((entry)=>({
        startedDateTime:new Date(entry.timestamp||startedAt).toISOString(),time:0,
        request:{method:entry.method||'GET',url:entry.url||'',httpVersion:'HTTP/1.1',
          headers:Object.entries(entry.requestHeaders||{}).map(([name,value])=>({name,value:String(value)})),queryString:[],cookies:[],headersSize:-1,bodySize:-1},
        response:{status:Number(entry.status)||0,statusText:'',httpVersion:'HTTP/1.1',
          headers:Object.entries(entry.responseHeaders||{}).map(([name,value])=>({name,value:String(value)})),cookies:[],
          content:{size:Number(entry.size)||String(entry.responseBody||'').length,mimeType:entry.mimeType||entry.responseHeaders?.['content-type']||'',text:entry.responseBody||''},
          redirectURL:'',headersSize:-1,bodySize:Number(entry.size)||-1},cache:{},timings:{send:0,wait:0,receive:0}
      }));
      return {har:{log:{version:'1.2',creator:{name:'Pebble',version:'1'},pages:[],entries}}};
    }
    if(input.command==='profilerStart'||input.command==='profilerStop'){
      if(input.command==='profilerStart'){
        globalThis.__pebblePerformanceProfile?.observer?.disconnect();
        const profile={startedAt:Date.now(),timeOrigin:performance.timeOrigin,entries:performance.getEntries().slice(-20000),observer:null};
        const supported=PerformanceObserver.supportedEntryTypes||[];
        if(supported.length){
          profile.observer=new PerformanceObserver((list)=>{
            profile.entries.push(...list.getEntries());
            if(profile.entries.length>20000) profile.entries.splice(0,profile.entries.length-20000);
          });
          profile.observer.observe({entryTypes:supported});
        }
        globalThis.__pebblePerformanceProfile=profile;
        return {recording:true,startedAt:profile.startedAt,entryTypes:supported};
      }
      const profile=globalThis.__pebblePerformanceProfile;
      if(!profile) fail('Browser profiler has not started in this document.');
      profile.observer?.disconnect();
      delete globalThis.__pebblePerformanceProfile;
      const traceEvents=[{name:'process_name',cat:'__metadata',ph:'M',pid:1,tid:1,args:{name:'Pebble browser page'}}];
      for(const entry of profile.entries){
        traceEvents.push({name:entry.name||entry.entryType,cat:'devtools.timeline',ph:'X',pid:1,tid:1,
          ts:Math.round((profile.timeOrigin+entry.startTime)*1000),dur:Math.max(0,Math.round(entry.duration*1000)),
          args:{entryType:entry.entryType,detail:entry.toJSON?.()||{}}});
      }
      return {profile:{traceEvents,metadata:{source:'Performance Timeline',startedAt:profile.startedAt,stoppedAt:Date.now(),url:location.href}}};
    }
    if(input.command==='pushState'){
      const target=new URL(input.url,location.href);
      const router=globalThis.next?.router;
      if(router&&typeof router.push==='function') await router.push(target.href);
      else {history.pushState({},'',target.href);window.dispatchEvent(new PopStateEvent('popstate',{state:history.state}));}
      return {url:location.href};
    }
    if(input.command==='eval'){
      const value=(0,eval)(input.expression);
      const resolved=value&&typeof value.then==='function'?await value:value;
      let result;
      try{result=typeof resolved==='string'?resolved:JSON.stringify(resolved);}
      catch{result=String(resolved);}
      return {result:result??String(resolved),origin:location.origin};
    }
    if(input.command==='interceptEnable'||input.command==='interceptDisable'||input.command==='interceptList'){
      const capture=globalThis.__pebbleAutomationCapture;
      if(!capture) fail('Browser interception hooks are not available on this page. Reload and retry.');
      if(input.command==='interceptEnable'){
        capture.interceptPatterns=input.patterns; capture.interceptRoutes=input.routes; capture.intercepted.length=0;
        return {enabled:true,patterns:[...capture.interceptPatterns],routes:[...capture.interceptRoutes]};
      }
      if(input.command==='interceptDisable'){
        capture.interceptPatterns=[]; capture.interceptRoutes=[]; return {disabled:true};
      }
      return {requests:[...capture.intercepted],patterns:[...capture.interceptPatterns],routes:[...capture.interceptRoutes]};
    }
    if(input.command==='wait'){
      if(input.duration!==null){await new Promise((resolve)=>setTimeout(resolve,input.duration));return {waited:true,duration:input.duration};}
      const deadline=Date.now()+input.timeout;
      let networkIdleSince=null;
      const matches=()=>{
        if(input.url&&!location.href.includes(input.url)) return false;
        if(input.text&&!deepText().includes(input.text)) return false;
        if(input.load==='networkidle'){
          const inflight=globalThis.__pebbleAutomationCapture?.networkInflight||0;
          if(inflight>0){networkIdleSince=null;return false;}
          if(networkIdleSince===null){networkIdleSince=Date.now();return false;}
          if(Date.now()-networkIdleSince<500) return false;
        }else if(input.load&&document.readyState!==input.load) return false;
        if(input.fn&&!Boolean((0,eval)(input.fn))) return false;
        if(input.selector){
          const candidates=queryTargetAll(input.selector);const candidate=candidates[0];
          if(!candidate){
            if(routeState.blockedFrames>0) fail('Browser wait selector could not be verified because cross-origin frames were not searched.');
            return input.state==='detached';
          }
          if(input.state==='hidden') return isHtmlElement(candidate)&&(styleOf(candidate).display==='none'||styleOf(candidate).visibility==='hidden');
          if(input.state==='detached') return false;
        }
        return true;
      };
      while(!matches()){
        if(Date.now()>=deadline) fail('Browser wait timed out.');
        await new Promise((resolve)=>setTimeout(resolve,50));
      }
      return {waited:true};
    }
    if(input.command==='snapshot'){
      clearAutomationRefs();routeState.blockedFrames=0;
      let root;
      try{root=input.selector?resolveTarget(input.selector):document.body||document.documentElement;}
      catch(error){fail(error instanceof Error?error.message:'Invalid browser snapshot selector.');}
      if(!isHtmlElement(root)) fail('Browser snapshot selector did not match an HTML element.');
      const interactiveSelector='a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[tabindex]:not([tabindex="-1"])';
      const routed=routedElements(root).filter(({node})=>!input.interactive||node.matches(interactiveSelector)).slice(0,5000);
      const refs=[]; const lines=[]; let index=1;
      for(const {node,depth} of routed){
        if(!isHtmlElement(node)) continue;
        const style=styleOf(node); const rect=node.getBoundingClientRect();
        if(style.display==='none'||style.visibility==='hidden'||rect.width<1||rect.height<1) continue;
        if(input.depth!==null&&depth>input.depth) continue;
        const interactive=node.matches(interactiveSelector); const ref=interactive?'@e'+index++:null;
        if(ref) node.setAttribute('data-pebble-automation-ref',ref.slice(1));
        const role=(node.getAttribute('role')||node.tagName.toLowerCase()).replace(/^h[1-6]$/,'heading');
        const name=(node.getAttribute('aria-label')||node.getAttribute('alt')||node.getAttribute('placeholder')||node.textContent||node.getAttribute('name')||'').trim().replace(/\\s+/g,' ').slice(0,200);
        if(input.compact&&!interactive&&!name) continue;
        const url=input.includeUrls&&isTag(node,'a')?node.href:'';
        if(ref) refs.push({ref,role,name});
        lines.push('  '.repeat(depth)+(ref?'['+ref+'] ':'')+role+(name?' "'+name.replace(/"/g,'\\"')+'"':'')+(url?' url="'+url.replace(/"/g,'%22')+'"':''));
      }
      if(routeState.blockedFrames>0) lines.push('[blocked-frame] cross-origin or unavailable');
      return {snapshot:lines.join('\\n'),refs,url:location.href,title:document.title,routing:{blockedFrames:routeState.blockedFrames}};
    }
    if(input.command==='get'&&(input.what==='url'||input.what==='title')){
      return input.what==='url'?{url:location.href}:{title:document.title};
    }
    if(input.command==='keyboardInsertText'){
      const active=deepActiveElement();
      if(!isHtmlElement(active)) fail('No browser element is focused.');
      const previous=isTag(active,'input')||isTag(active,'textarea')?active.value:(active.textContent||'');
      setText(active,previous+input.text); return {inserted:true};
    }
    if(input.command==='find'){
      const candidates=allRoots().flatMap((root)=>queryRoot(root,'a,button,input,textarea,select,[role],[aria-label],[placeholder],[alt],[title],[data-testid]')).filter(isHtmlElement);
      const normalized=input.value.toLocaleLowerCase();
      const matches=(candidate)=>{
        const text=(candidate.textContent||'').trim();
        if(input.locator==='role') return (candidate.getAttribute('role')||candidate.tagName.toLowerCase())===input.value;
        if(input.locator==='text') return text.includes(input.value);
        if(input.locator==='label') return (candidate.getAttribute('aria-label')||'').toLocaleLowerCase().includes(normalized);
        if(input.locator==='placeholder') return (candidate.getAttribute('placeholder')||'').toLocaleLowerCase().includes(normalized);
        if(input.locator==='alt') return (candidate.getAttribute('alt')||'').toLocaleLowerCase().includes(normalized);
        if(input.locator==='title') return (candidate.getAttribute('title')||'').toLocaleLowerCase().includes(normalized);
        if(input.locator==='testid') return candidate.getAttribute('data-testid')===input.value;
        return false;
      };
      const matching=input.locator==='css'
        ? queryTargetAll(input.value)
        : candidates.filter(matches);
      const node=input.position==='last'?matching.at(-1):input.position==='nth'?matching[input.index]:matching[0];
      if(!isHtmlElement(node)) fail('Element not found. Verify the locator is correct and the element exists in the DOM.');
      const located="[data-agent-browser-located='true']"; node.setAttribute('data-agent-browser-located','true');
      try{
        if(input.action==='click'){node.click();return {clicked:located};}
        if(input.action==='focus'){node.focus();return {focused:located};}
        if(input.action==='fill'){node.focus();setText(node,input.text);return {filled:located};}
        if(input.action==='type'){
          node.focus();const previous=isTag(node,'input')||isTag(node,'textarea')?node.value:(node.textContent||'');
          setText(node,previous+input.text);return {typed:located};
        }
        if(input.action==='hover'){
          node.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window}));
          node.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false,cancelable:false,view:window}));
          return {hovered:located};
        }
        if(input.action==='check'){
          if(!isTag(node,'input')||!['checkbox','radio'].includes(node.type)) fail('Located browser element is not checkable.');
          if(!node.checked) node.click(); return {checked:located,value:node.checked};
        }
        fail('Unsupported browser find action.');
      } finally {node.removeAttribute('data-agent-browser-located');}
    }
    if(input.command==='scroll'){
      const vertical=input.direction==='up'||input.direction==='down';
      const negative=input.direction==='up'||input.direction==='left';
      window.scrollBy({top:vertical?(negative?-input.amount:input.amount):0,left:vertical?0:(negative?-input.amount:input.amount),behavior:'auto'});
      return {scrolled:input.direction};
    }
    if(input.command==='type'||input.command==='keypress'||input.command==='keyDown'||input.command==='keyUp'){
      const node=input.command==='type'&&input.element?resolveTarget(input.element):deepActiveElement();
      if(!isHtmlElement(node)) fail('No browser element is focused.');
      if(input.command==='keypress'||input.command==='keyDown'||input.command==='keyUp'){
        if(input.command!=='keyUp') node.dispatchEvent(new KeyboardEvent('keydown',{key:input.key,bubbles:true}));
        if(input.command!=='keyDown') node.dispatchEvent(new KeyboardEvent('keyup',{key:input.key,bubbles:true}));
        return input.command==='keyDown'?{keyDown:input.key}:input.command==='keyUp'?{keyUp:input.key}:{pressed:input.key};
      }
      node.focus();
      const previous=isTag(node,'input')||isTag(node,'textarea')?node.value:(node.textContent||'');
      setText(node,previous+input.text);
      return {typed:true};
    }
    if(input.command==='get'&&input.what==='count'){
      const matches=queryTargetAll(input.element);
      return {origin:location.href,count:matches.length,incomplete:routeState.blockedFrames>0,blockedFrames:routeState.blockedFrames};
    }
    const node=resolveTarget(input.element);
    if(input.command==='resolvePoint'){
      if(input.focus) node.focus({preventScroll:true});
      node.scrollIntoView({block:'center',inline:'center',behavior:'auto'});
      const style=styleOf(node); const box=pageRect(node);
      if(style.display==='none'||style.visibility==='hidden'||style.opacity==='0'||box.width<=0||box.height<=0) fail('Browser element is not visible.');
      return {element:input.element,x:box.left+box.width/2,y:box.top+box.height/2};
    }
    if(input.command==='resolveSelectOption'){
      if(!isTag(node,'select')) fail('Browser element is not a select control.');
      node.focus({preventScroll:true});
      const options=Array.from(node.options); const index=options.findIndex((option)=>option.value===input.value||option.text===input.value);
      if(index<0) fail('Browser select option was not found.');
      const option=options[index];
      if(!node.multiple) return {element:input.element,index,multiple:false,text:option.text,value:option.value};
      option.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'auto'});
      const localBox=node.getBoundingClientRect(); const box=pageRect(node); const optionBox=option.getBoundingClientRect();
      const fallbackHeight=localBox.height/Math.max(1,node.size||Math.min(options.length,4));
      const rowHeight=optionBox.height>0?optionBox.height:(option.offsetHeight||fallbackHeight);
      const relativeTop=optionBox.height>0?optionBox.top-localBox.top:option.offsetTop-node.scrollTop;
      const x=optionBox.width>0?box.left+(optionBox.left-localBox.left)+optionBox.width/2:box.left+box.width/2;
      const y=box.top+Math.max(rowHeight/2,Math.min(box.height-rowHeight/2,relativeTop+rowHeight/2));
      if(!Number.isFinite(x)||!Number.isFinite(y)||box.width<=0||box.height<=0) fail('Browser select option is not visible.');
      return {element:input.element,index,multiple:true,value:option.value,x,y};
    }
    if(input.command==='readSelectValues'){
      if(!isTag(node,'select')) fail('Browser element is not a select control.');
      return {element:input.element,multiple:node.multiple,values:Array.from(node.selectedOptions,(option)=>option.value)};
    }
    if(input.command==='get'){
      const origin=node.ownerDocument.location.href;
      if(input.what==='text') return {origin,text:(node.innerText||node.textContent||'').trim()};
      if(input.what==='html') return {origin,html:node.innerHTML};
      if(input.what==='value') return {origin,value:'value' in node?String(node.value??''):''};
      if(input.what==='attr') return {origin,name:input.attribute,value:node.getAttribute(input.attribute)};
      if(input.what==='box'){const box=pageRect(node);return {origin,box:{x:box.left,y:box.top,width:box.width,height:box.height}};}
      if(input.what==='styles'){
        const styles=styleOf(node); return {origin,styles:{display:styles.display,visibility:styles.visibility,opacity:styles.opacity,color:styles.color,backgroundColor:styles.backgroundColor,fontSize:styles.fontSize}};
      }
      fail('Unsupported browser get property.');
    }
    if(input.command==='is'){
      const origin=node.ownerDocument.location.href;
      if(input.what==='visible'){const style=styleOf(node);const box=node.getBoundingClientRect();return {origin,visible:style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&box.width>0&&box.height>0};}
      if(input.what==='enabled') return {origin,enabled:!('disabled' in node&&Boolean(node.disabled))&&node.getAttribute('aria-disabled')!=='true'};
      if(input.what==='checked') return {origin,checked:isTag(node,'input')?node.checked:node.getAttribute('aria-checked')==='true'};
      fail('Unsupported browser state check.');
    }
    if(input.command==='drag'){
      const target=resolveTarget(input.to);
      const transfer=typeof DataTransfer==='function'?new DataTransfer():undefined;
      node.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      node.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:false,dataTransfer:transfer}));
      return {dragged:input.element,to:input.to};
    }
    if(input.command==='click'||input.command==='dblclick'){
      if(input.command==='click') node.click();
      else node.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window,detail:2}));
      return {clicked:input.element};
    }
    if(input.command==='hover'){
      node.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window}));
      node.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false,cancelable:false,view:window}));
      return {hovered:input.element};
    }
    if(input.command==='focus'){node.focus();return {focused:input.element};}
    if(input.command==='scrollIntoView'){node.scrollIntoView({block:'center',inline:'nearest'});return {scrolled:input.element};}
    if(input.command==='select'){
      fail('Browser select requires native keyboard or mouse input on this platform.');
    }
    if(input.command==='check'){
      if(!isTag(node,'input')||!['checkbox','radio'].includes(node.type)) fail('Browser element is not checkable.');
      if(node.checked!==input.checked) node.click();
      return {checked:input.element,value:node.checked};
    }
    if(input.command==='selectAll'){
      node.focus();
      if(isTag(node,'input')||isTag(node,'textarea')) node.select();
      else if(node.isContentEditable){const range=node.ownerDocument.createRange();range.selectNodeContents(node);const selection=node.ownerDocument.defaultView?.getSelection();selection?.removeAllRanges();selection?.addRange(range);}
      else fail('Browser element does not support select all.');
      return {selectedAll:input.element};
    }
    if(input.command==='upload'){
      if(!isTag(node,'input')||node.type!=='file') fail('Browser element is not a file input.');
      const transfer=new DataTransfer();
      for(const file of input.files){
        const binary=atob(file.dataBase64); const bytes=new Uint8Array(binary.length);
        for(let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
        transfer.items.add(new File([bytes],file.name,{type:file.mimeType}));
      }
      const inputConstructor=node.ownerDocument.defaultView?.HTMLInputElement;
      const setter=inputConstructor&&Object.getOwnPropertyDescriptor(inputConstructor.prototype,'files')?.set;
      if(!setter) fail('Browser file input setter is unavailable.');
      setter.call(node,transfer.files); emitInput(node); return {uploaded:transfer.files.length};
    }
    if(input.command==='fill'||input.command==='clear'){
      const value=input.command==='clear'?'':input.text;
      node.focus();
      setText(node,value);
      return input.command==='fill'?{filled:input.element}:{cleared:input.element};
    }
    fail('Unsupported browser DOM command.');
  })()`
}

function validateAutomationPayload(
  command: TauriBrowserDomCommand,
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (command === 'snapshot') {
    return {
      command,
      interactive: payload.interactive === true,
      compact: payload.compact === true,
      includeUrls: payload.includeUrls === true,
      depth:
        typeof payload.depth === 'number' && Number.isFinite(payload.depth)
          ? Math.max(0, Math.min(64, Math.floor(payload.depth)))
          : null,
      selector: readOptionalBoundedText(payload.selector, 'browser snapshot selector', 4096)
    }
  }
  if (command === 'resolvePoint') {
    return {
      command,
      element: readElementTarget(payload.element),
      focus: payload.focus === true
    }
  }
  if (command === 'resolveSelectOption') {
    return {
      command,
      element: readElementTarget(payload.element),
      value: readBoundedText(payload.value, 'browser select value', MAX_AUTOMATION_TEXT, true)
    }
  }
  if (command === 'readSelectValues') {
    return { command, element: readElementTarget(payload.element) }
  }
  if (command === 'captureStart' || command === 'captureStop') {
    return { command }
  }
  if (command === 'harStart' || command === 'harStop') {
    return { command }
  }
  if (command === 'profilerStart' || command === 'profilerStop') {
    return { command }
  }
  if (command === 'interceptEnable') {
    const values = payload.patterns === undefined ? ['**/*'] : payload.patterns
    if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
      throw new Error('Browser interception requires 1 to 32 URL patterns.')
    }
    const patterns = values.map((value) =>
      readBoundedText(value, 'browser intercept pattern', 2048)
    )
    const routeValues =
      payload.routes === undefined
        ? patterns.map((pattern) => ({ pattern, action: 'abort' }))
        : payload.routes
    if (!Array.isArray(routeValues) || routeValues.length !== patterns.length) {
      throw new Error('Browser interception routes must match URL patterns.')
    }
    const routes = routeValues.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser intercept route must be an object.')
      }
      const route = value as Record<string, unknown>
      const pattern = readBoundedText(route.pattern, 'browser intercept pattern', 2048)
      if (route.action === 'abort') {
        return { pattern, action: 'abort' }
      }
      if (route.action !== 'fulfill') {
        throw new Error('Browser intercept action must be abort or fulfill.')
      }
      const status = typeof route.status === 'number' ? Math.floor(route.status) : 200
      if (status < 100 || status > 599) {
        throw new Error('Browser intercept status is invalid.')
      }
      return {
        pattern,
        action: 'fulfill',
        body: readOptionalBoundedText(route.body, 'browser intercept body', 4 * 1024 * 1024) ?? '',
        status,
        contentType:
          readOptionalBoundedText(route.contentType, 'browser intercept content type', 512) ??
          'application/json'
      }
    })
    return { command, patterns, routes }
  }
  if (command === 'interceptDisable' || command === 'interceptList') {
    return { command }
  }
  if (command === 'console' || command === 'network') {
    const limit =
      typeof payload.limit === 'number' && Number.isFinite(payload.limit)
        ? Math.max(1, Math.min(1000, Math.floor(payload.limit)))
        : 100
    return {
      command,
      limit,
      clear: payload.clear === true,
      errorsOnly: command === 'console' && payload.errorsOnly === true,
      filter: readOptionalBoundedText(payload.filter, 'browser capture filter', 2048),
      requestId: readOptionalBoundedText(payload.requestId, 'browser request id', 256),
      types: Array.isArray(payload.types)
        ? payload.types.map((value) => readBoundedText(value, 'browser resource type', 32))
        : [],
      method:
        readOptionalBoundedText(payload.method, 'browser request method', 32)?.toUpperCase() ??
        null,
      status: readOptionalBoundedText(payload.status, 'browser response status', 32)
    }
  }
  if (command === 'pushState') {
    return {
      command,
      url: readBoundedText(payload.url, 'browser SPA URL', 4096)
    }
  }
  if (command === 'eval') {
    return {
      command,
      expression: readBoundedText(payload.expression, 'browser expression', 512 * 1024)
    }
  }
  if (command === 'clipboardRead' || command === 'clipboardCopy' || command === 'clipboardPaste') {
    return { command }
  }
  if (command === 'clipboardWrite') {
    return {
      command,
      text: readBoundedText(payload.text, 'browser clipboard text')
    }
  }
  if (command === 'download') {
    return {
      command,
      element: readElementTarget(payload.selector ?? payload.element)
    }
  }
  if (command === 'geolocation') {
    const latitude = readBoundedNumber(payload.latitude, 'browser latitude')
    const longitude = readBoundedNumber(payload.longitude, 'browser longitude')
    const accuracy =
      payload.accuracy === undefined
        ? 1
        : readBoundedNumber(payload.accuracy, 'browser geolocation accuracy')
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy <= 0) {
      throw new Error('Invalid browser geolocation coordinates.')
    }
    return { command, latitude, longitude, accuracy }
  }
  if (command === 'setMedia') {
    const colorScheme = readMediaPreference(payload.colorScheme, 'browser color scheme', [
      'light',
      'dark',
      'no-preference'
    ])
    const reducedMotion = readMediaPreference(payload.reducedMotion, 'browser reduced motion', [
      'reduce',
      'no-preference'
    ])
    return { command, colorScheme, reducedMotion }
  }
  if (command.startsWith('storage')) {
    if (command.endsWith('Clear')) {
      return { command }
    }
    const key = readOptionalBoundedText(payload.key, 'browser storage key', 64 * 1024)
    return command.endsWith('Set')
      ? {
          command,
          key: key ?? readBoundedText(payload.key, 'browser storage key', 64 * 1024),
          value: readBoundedText(payload.value, 'browser storage value', MAX_AUTOMATION_TEXT, true)
        }
      : { command, key }
  }
  if (command === 'highlight') {
    return {
      command,
      selector: readBoundedText(payload.selector, 'browser highlight selector', 4096)
    }
  }
  if (command === 'mouseMove' || command === 'mouseClick') {
    return {
      command,
      x: readBoundedNumber(payload.x, 'browser mouse x'),
      y: readBoundedNumber(payload.y, 'browser mouse y'),
      ...(command === 'mouseClick'
        ? {
            button: readMouseButton(payload.button),
            modifiers: readMouseModifiers(payload.modifiers)
          }
        : {})
    }
  }
  if (command === 'mouseDown' || command === 'mouseUp') {
    return { command, button: readMouseButton(payload.button) }
  }
  if (command === 'mouseWheel') {
    return {
      command,
      dx: readBoundedNumber(payload.dx ?? 0, 'browser mouse wheel dx'),
      dy: readBoundedNumber(payload.dy, 'browser mouse wheel dy')
    }
  }
  if (command === 'wait') {
    const timeout =
      typeof payload.timeout === 'number' && Number.isFinite(payload.timeout)
        ? Math.max(1, Math.min(120_000, payload.timeout))
        : 30_000
    const state = ['visible', 'hidden', 'attached', 'detached'].includes(String(payload.state))
      ? String(payload.state)
      : 'visible'
    return {
      command,
      timeout,
      duration:
        typeof payload.duration === 'number' && Number.isFinite(payload.duration)
          ? Math.max(0, Math.min(120_000, payload.duration))
          : null,
      state,
      selector: readOptionalBoundedText(payload.selector, 'browser wait selector', 4096),
      text: readOptionalBoundedText(payload.text, 'browser wait text', 64 * 1024),
      url: readOptionalBoundedText(payload.url, 'browser wait URL', 4096),
      load: readOptionalEnum(payload.load, ['loading', 'interactive', 'complete', 'networkidle']),
      fn: readOptionalBoundedText(payload.fn, 'browser wait function', 64 * 1024)
    }
  }
  if (command === 'scroll') {
    const direction = ['up', 'down', 'left', 'right'].includes(String(payload.direction))
      ? String(payload.direction)
      : null
    if (!direction) {
      throw new Error('Browser scroll direction must be up, down, left, or right.')
    }
    const requested =
      typeof payload.amount === 'number' && Number.isFinite(payload.amount) ? payload.amount : 500
    return {
      command,
      direction,
      amount: Math.max(1, Math.min(MAX_SCROLL_AMOUNT, requested))
    }
  }
  if (command === 'type') {
    return {
      command,
      text: readBoundedText(payload.input, 'browser type input'),
      ...(payload.element === undefined ? {} : { element: readElementTarget(payload.element) })
    }
  }
  if (command === 'keypress' || command === 'keyDown' || command === 'keyUp') {
    const key = readBoundedText(payload.key, 'browser key', 64)
    return { command, key }
  }
  if (command === 'drag') {
    return {
      command,
      element: readElementTarget(payload.from),
      to: readElementTarget(payload.to)
    }
  }
  if (command === 'upload') {
    const files = Array.isArray(payload.files) ? payload.files : []
    if (files.length === 0 || files.length > 16) {
      throw new Error('Browser upload requires 1 to 16 files.')
    }
    return {
      command,
      element: readElementTarget(payload.element),
      files: files.map((file) => validateUploadFile(file))
    }
  }
  if (command === 'get') {
    const what = readEnum(payload.what, 'browser get property', [
      'text',
      'html',
      'value',
      'attr',
      'url',
      'title',
      'count',
      'box',
      'styles'
    ])
    return what === 'url' || what === 'title'
      ? { command, what }
      : {
          command,
          what,
          element: readElementTarget(payload.selector ?? payload.element),
          ...(what === 'attr'
            ? {
                attribute: readBoundedText(payload.attribute, 'browser attribute name', 256)
              }
            : {})
        }
  }
  if (command === 'is') {
    return {
      command,
      what: readEnum(payload.what, 'browser state check', ['visible', 'enabled', 'checked']),
      element: readElementTarget(payload.selector ?? payload.element)
    }
  }
  if (command === 'keyboardInsertText') {
    return {
      command,
      text: readBoundedText(payload.text, 'browser keyboard text')
    }
  }
  if (command === 'find') {
    const action = readEnum(payload.action, 'browser find action', [
      'click',
      'focus',
      'fill',
      'check',
      'type',
      'hover'
    ])
    return {
      command,
      locator: readEnum(payload.locator, 'browser find locator', [
        'role',
        'text',
        'label',
        'placeholder',
        'alt',
        'title',
        'testid',
        'css'
      ]),
      value: readBoundedText(payload.value, 'browser find value', 4096),
      action,
      position: readOptionalEnum(payload.position, ['first', 'last', 'nth']),
      index:
        payload.position === 'nth'
          ? Math.max(0, Math.floor(readBoundedNumber(payload.index, 'browser find index')))
          : null,
      text:
        action === 'fill' || action === 'type'
          ? readBoundedText(payload.text, 'browser find text', MAX_AUTOMATION_TEXT, true)
          : null
    }
  }
  const element = readElementTarget(payload.element)
  if (command === 'fill') {
    return {
      command,
      element,
      text: readBoundedText(payload.value, 'browser fill value', MAX_AUTOMATION_TEXT, true)
    }
  }
  if (command === 'select') {
    const values = Array.isArray(payload.values)
      ? payload.values
      : payload.value === undefined
        ? []
        : [payload.value]
    if (values.length < 1 || values.length > 64) {
      throw new Error('Browser select requires 1 to 64 values.')
    }
    return {
      command,
      element,
      values: values.map((value) => readBoundedText(value, 'browser select value', 4096, true))
    }
  }
  if (command === 'check') {
    return { command, element, checked: payload.checked !== false }
  }
  return { command, element }
}

function readMediaPreference(value: unknown, label: string, allowed: readonly string[]): string {
  const normalized =
    typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'no-preference'
  if (!allowed.includes(normalized)) {
    throw new Error(`Invalid ${label}.`)
  }
  return normalized
}

function readBoundedNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return Math.max(-MAX_MOUSE_COORDINATE, Math.min(MAX_MOUSE_COORDINATE, value))
}

function readMouseButton(value: unknown): string {
  return value === undefined
    ? 'left'
    : readEnum(value, 'browser mouse button', ['left', 'middle', 'right'])
}

function readMouseModifiers(value: unknown): string[] {
  if (value === undefined) {
    return []
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => !['Alt', 'Control', 'Meta', 'Shift'].includes(String(entry)))
  ) {
    throw new Error('Invalid browser mouse modifiers.')
  }
  return value.map(String)
}

function readEnum(value: unknown, label: string, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}

function validateUploadFile(value: unknown): Record<string, string> {
  const file = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    name: readBoundedText(file.name, 'browser upload file name', 1024),
    mimeType: readBoundedText(file.mimeType, 'browser upload MIME type', 256),
    dataBase64: readBoundedText(file.dataBase64, 'browser upload data', 48 * 1024 * 1024)
  }
}

function readOptionalBoundedText(value: unknown, label: string, limit: number): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  return readBoundedText(value, label, limit)
}

function readOptionalEnum(value: unknown, allowed: string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null
}

function readElementTarget(value: unknown): string {
  return readBoundedText(value, 'browser element selector or @eN ref', 4096)
}

function readBoundedText(
  value: unknown,
  label: string,
  limit = MAX_AUTOMATION_TEXT,
  allowEmpty = false
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > limit) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}
