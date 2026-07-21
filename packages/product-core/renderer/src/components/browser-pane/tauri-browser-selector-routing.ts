export const TAURI_BROWSER_SELECTOR_ROUTING_RUNTIME = String.raw`
    const isHtmlElement=(node)=>{
      const constructor=node?.ownerDocument?.defaultView?.HTMLElement;
      return typeof constructor==='function'&&node instanceof constructor;
    };
    const isTag=(node,name)=>isHtmlElement(node)&&node.tagName.toLowerCase()===name;
    const styleOf=(node)=>node.ownerDocument.defaultView.getComputedStyle(node);
    const routeState={blockedFrames:0};
    const readFrameDocument=(frame,strict)=>{
      let child=null;
      try{child=frame.contentDocument;}
      catch{}
      if(child) return child;
      routeState.blockedFrames++;
      if(strict) fail('Browser selector route cannot enter a cross-origin or unavailable frame.');
      return null;
    };
    const childRoots=(root,strictFrames=false)=>{
      const roots=[];
      let elements=[];
      try{elements=Array.from(root.querySelectorAll('*'));}
      catch{fail('Invalid browser element selector.');}
      for(const element of elements){
        if(element.shadowRoot) roots.push(element.shadowRoot);
        if(isTag(element,'iframe')||isTag(element,'frame')){
          const child=readFrameDocument(element,strictFrames);
          if(child) roots.push(child);
        }
      }
      return roots;
    };
    const allRoots=(root=document)=>{
      const roots=[];const pending=[root];const seen=new Set();
      while(pending.length){
        const current=pending.shift();
        if(!current||seen.has(current)) continue;
        seen.add(current);roots.push(current);
        pending.push(...childRoots(current));
      }
      return roots;
    };
    const queryRoot=(root,selector)=>{
      try{return Array.from(root.querySelectorAll(selector));}
      catch{fail('Invalid browser element selector.');}
    };
    const queryRoute=(target)=>{
      const segments=target.split(/\s*>>>\s*/);
      if(segments.some((segment)=>!segment)) fail('Invalid browser selector route.');
      let roots=[document];
      for(let index=0;index<segments.length;index++){
        const matches=roots.flatMap((root)=>queryRoot(root,segments[index])).filter(isHtmlElement);
        if(index===segments.length-1) return matches;
        if(matches.length===0) fail('Browser selector route segment did not match an HTML element.');
        if(matches.length!==1) fail('Browser selector route segment is ambiguous.');
        const host=matches[0];
        if(host.shadowRoot){roots=[host.shadowRoot];continue;}
        if(isTag(host,'iframe')||isTag(host,'frame')){
          roots=[readFrameDocument(host,true)];continue;
        }
        fail('Browser selector route segment does not expose an open shadow root or frame document.');
      }
      return [];
    };
    const queryTargetAll=(target)=>{
      routeState.blockedFrames=0;
      if(/^@e[1-9][0-9]*$/.test(target)){
        const selector='[data-pebble-automation-ref="'+target.slice(1)+'"]';
        return allRoots().flatMap((root)=>queryRoot(root,selector)).filter(isHtmlElement);
      }
      if(target.includes('>>>')) return queryRoute(target);
      return allRoots().flatMap((root)=>queryRoot(root,target)).filter(isHtmlElement);
    };
    const resolveTarget=(target)=>{
      const matches=queryTargetAll(target);
      const node=matches[0];
      if(!isHtmlElement(node)){
        if(routeState.blockedFrames>0) fail('Browser element was not found in accessible documents; cross-origin frames were not searched.');
        fail(target.startsWith('@e')?'Browser element ref is stale. Run browser.snapshot again.':'Browser element selector did not match an HTML element.');
      }
      return node;
    };
    const deepActiveElement=()=>{
      let active=document.activeElement;
      const seen=new Set();
      while(active&&!seen.has(active)){
        seen.add(active);
        if(active.shadowRoot?.activeElement){active=active.shadowRoot.activeElement;continue;}
        if(isTag(active,'iframe')||isTag(active,'frame')){
          const child=readFrameDocument(active,true);
          active=child.activeElement;continue;
        }
        break;
      }
      return active;
    };
    const pageRect=(node)=>{
      const rect=node.getBoundingClientRect();let left=rect.left;let top=rect.top;
      let view=node.ownerDocument?.defaultView;const seen=new Set();
      while(view&&view!==window&&!seen.has(view)){
        seen.add(view);
        let frame=null;
        try{frame=view.frameElement;}
        catch{fail('Browser element frame route became unavailable.');}
        if(!frame) fail('Browser element frame route is detached.');
        const frameRect=frame.getBoundingClientRect();left+=frameRect.left+(frame.clientLeft||0);top+=frameRect.top+(frame.clientTop||0);
        view=frame.ownerDocument?.defaultView;
      }
      return {left,top,width:rect.width,height:rect.height,right:left+rect.width,bottom:top+rect.height};
    };
    const clearAutomationRefs=()=>{
      for(const root of allRoots()){
        for(const node of queryRoot(root,'[data-pebble-automation-ref]')) node.removeAttribute('data-pebble-automation-ref');
      }
    };
    const routedElements=(root)=>{
      const rows=[];const seen=new Set();
      const visit=(container,baseDepth)=>{
        for(const node of Array.from(container.children||[])){
          if(!isHtmlElement(node)||seen.has(node)) continue;
          seen.add(node);rows.push({node,depth:baseDepth});
          if(node.shadowRoot) visit(node.shadowRoot,baseDepth+1);
          if(isTag(node,'iframe')||isTag(node,'frame')){
            const child=readFrameDocument(node,false);
            if(child?.documentElement) visit(child.documentElement,baseDepth+1);
          }
          visit(node,baseDepth+1);
        }
      };
      visit(root,0);return rows;
    };
    const deepText=()=>allRoots().map((root)=>root.body?.innerText||root.textContent||'').join('\n');
`
