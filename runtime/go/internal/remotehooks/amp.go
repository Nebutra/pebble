package remotehooks

import (
	"os"
	"path/filepath"
	"strings"
)

const ampMarker = "Managed by Pebble. Do not edit; changes may be overwritten."

func installAmp(home string) InstallStatus {
	path := filepath.Join(home, ".config", "amp", "plugins", "pebble-agent-status.ts")
	if existing, err := os.ReadFile(path); err == nil && !strings.Contains(string(existing), ampMarker) {
		return InstallStatus{Agent: "amp", State: "partial", ConfigPath: path, Detail: "Amp Pebble status plugin exists but is not Pebble-managed"}
	} else if err != nil && !os.IsNotExist(err) {
		return errorInstall("amp", path, err)
	}
	if err := writeAtomic(path, []byte(ampPluginSource), 0o600); err != nil {
		return errorInstall("amp", path, err)
	}
	return InstallStatus{Agent: "amp", State: "installed", ConfigPath: path, ManagedHooksPresent: true}
}

const ampPluginSource = `import { readFileSync } from 'fs'
import type { PluginAPI } from '@ampcode/plugin'
// Managed by Pebble. Do not edit; changes may be overwritten.
function endpoint(): Record<string,string> { const out: Record<string,string> = {}; const path=process.env.PEBBLE_AGENT_HOOK_ENDPOINT; if(path) try { for(const line of readFileSync(path,'utf8').split(/\r?\n/)){ const m=line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/); if(m) out[m[1]]=m[2] } } catch{} return out }
function safe(value: unknown, depth=0): unknown { if(value==null||['string','number','boolean'].includes(typeof value)) return typeof value==='string'?value.slice(0,4000):value; if(depth>=4) return String(value).slice(0,4000); if(Array.isArray(value)) return value.slice(0,20).map(v=>safe(v,depth+1)); if(typeof value==='object') return Object.fromEntries(Object.entries(value).slice(0,20).map(([k,v])=>[k,safe(v,depth+1)])); return String(value) }
async function post(name:string,payload:Record<string,unknown>){ const file=endpoint(),port=file.PEBBLE_AGENT_HOOK_PORT||process.env.PEBBLE_AGENT_HOOK_PORT,token=file.PEBBLE_AGENT_HOOK_TOKEN||process.env.PEBBLE_AGENT_HOOK_TOKEN,paneKey=process.env.PEBBLE_PANE_KEY; if(!port||!token||!paneKey)return; const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),1000); try{await fetch(` + "`" + `http://127.0.0.1:${port}/hook/amp` + "`" + `,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-Pebble-Agent-Hook-Token':token},body:JSON.stringify({paneKey,tabId:process.env.PEBBLE_TAB_ID||'',launchToken:process.env.PEBBLE_AGENT_LAUNCH_TOKEN||'',worktreeId:process.env.PEBBLE_WORKTREE_ID||'',env:file.PEBBLE_AGENT_HOOK_ENV||process.env.PEBBLE_AGENT_HOOK_ENV||'',version:file.PEBBLE_AGENT_HOOK_VERSION||process.env.PEBBLE_AGENT_HOOK_VERSION||'',hook_event_name:name,payload:{hook_event_name:name,...payload}})})}catch{}finally{clearTimeout(timeout)} }
const MAX_PENDING_POSTS=50; type Item={name:string,payload:Record<string,unknown>}; const queue:Item[]=[]; let draining=false
async function drain(){if(draining)return;draining=true;try{while(queue.length){const item=queue.shift();if(item)await post(item.name,item.payload)}}finally{draining=false;if(queue.length)void drain()}}
function enqueue(name:string,payload:Record<string,unknown>){if(queue.length>=MAX_PENDING_POSTS)queue.shift();queue.push({name,payload});void drain()}
export default function(amp:PluginAPI){amp.on('session.start',e=>enqueue('session.start',{threadId:e.thread.id}));amp.on('agent.start',e=>enqueue('agent.start',{threadId:e.thread.id,id:e.id,message:e.message}));amp.on('tool.call',e=>{enqueue('tool.call',{threadId:e.thread.id,toolUseId:e.toolUseID,tool:e.tool,input:safe(e.input)});return{action:'allow'}});amp.on('tool.result',e=>enqueue('tool.result',{threadId:e.thread.id,toolUseId:e.toolUseID,tool:e.tool,input:safe(e.input),status:e.status,error:e.error,output:String(e.output??'').slice(0,4000)}));amp.on('agent.end',e=>enqueue('agent.end',{threadId:e.thread.id,id:e.id,message:e.message,status:e.status}))}
`
