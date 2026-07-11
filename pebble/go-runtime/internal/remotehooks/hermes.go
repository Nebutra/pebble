package remotehooks

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const hermesMarker = "Managed by Pebble. Do not edit; changes may be overwritten."

var hermesEvents = []string{"on_session_start", "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call", "pre_approval_request", "post_approval_response", "on_session_end", "on_session_finalize", "on_session_reset"}

func installHermes(home string) InstallStatus {
	configPath := filepath.Join(home, ".hermes", "config.yaml")
	pluginDir := filepath.Join(home, ".hermes", "plugins", "pebble-status")
	manifestPath := filepath.Join(pluginDir, "plugin.yaml")
	initPath := filepath.Join(pluginDir, "__init__.py")
	for _, path := range []string{manifestPath, initPath} {
		if content, err := os.ReadFile(path); err == nil && !strings.Contains(string(content), hermesMarker) {
			return InstallStatus{Agent: "hermes", State: "partial", ConfigPath: configPath, Detail: "Hermes pebble-status plugin exists but is not Pebble-managed"}
		} else if err != nil && !os.IsNotExist(err) {
			return errorInstall("hermes", configPath, err)
		}
	}
	config, err := readHermesConfig(configPath)
	if err != nil {
		return errorInstall("hermes", configPath, fmt.Errorf("could not parse Hermes config.yaml: %w", err))
	}
	enableHermesPlugin(config)
	content, err := yaml.Marshal(config)
	if err != nil {
		return errorInstall("hermes", configPath, err)
	}
	// Plugin files must exist before config.yaml makes Hermes load them.
	if err := writeAtomic(manifestPath, []byte(hermesManifest()), 0o600); err != nil {
		return errorInstall("hermes", configPath, err)
	}
	if err := writeAtomic(initPath, []byte(hermesPluginSource), 0o600); err != nil {
		return errorInstall("hermes", configPath, err)
	}
	if err := writeAtomic(configPath, content, 0o600); err != nil {
		return errorInstall("hermes", configPath, err)
	}
	return InstallStatus{Agent: "hermes", State: "installed", ConfigPath: configPath, ManagedHooksPresent: true}
}

func readHermesConfig(path string) (map[string]any, error) {
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) || len(strings.TrimSpace(string(content))) == 0 {
		return make(map[string]any), nil
	}
	if err != nil {
		return nil, err
	}
	config := make(map[string]any)
	if err := yaml.Unmarshal(content, &config); err != nil {
		return nil, err
	}
	return config, nil
}

func enableHermesPlugin(config map[string]any) {
	plugins, _ := config["plugins"].(map[string]any)
	if plugins == nil {
		plugins = make(map[string]any)
	}
	plugins["enabled"] = hermesStringList(plugins["enabled"], true)
	plugins["disabled"] = hermesStringList(plugins["disabled"], false)
	config["plugins"] = plugins
}

func hermesStringList(value any, include bool) []string {
	items := make([]string, 0)
	if values, ok := value.([]any); ok {
		for _, value := range values {
			if item, ok := value.(string); ok && item != "pebble-status" {
				items = append(items, item)
			}
		}
	} else if values, ok := value.([]string); ok {
		for _, item := range values {
			if item != "pebble-status" {
				items = append(items, item)
			}
		}
	}
	if include {
		items = append(items, "pebble-status")
	}
	sort.Strings(items)
	return items
}

func hermesManifest() string {
	lines := []string{"# " + hermesMarker, "name: pebble-status", "version: 1.0.0", `description: "Reports Hermes Agent lifecycle events to Pebble."`, `author: "Pebble"`, "kind: standalone", "provides_hooks:"}
	for _, event := range hermesEvents {
		lines = append(lines, "  - "+event)
	}
	return strings.Join(lines, "\n") + "\n"
}

const hermesPluginSource = `# Managed by Pebble. Do not edit; changes may be overwritten.
from __future__ import annotations
import json, os, urllib.error, urllib.request
from typing import Any, Callable, Optional

EVENTS = ["on_session_start","pre_llm_call","post_llm_call","pre_tool_call","post_tool_call","pre_approval_request","post_approval_response","on_session_end","on_session_finalize","on_session_reset"]
MAX_JSONABLE_DEPTH=5
MAX_JSONABLE_ITEMS=50
MAX_JSONABLE_NODES=500
MAX_JSONABLE_STRING=8192
TRUNCATED="...[truncated]"
SELECTED_KEYS={
 "on_session_start":("session_id","model","platform"),
 "pre_llm_call":("session_id","user_message","is_first_turn","model","platform","sender_id"),
 "post_llm_call":("session_id","user_message","assistant_response","model","platform"),
 "pre_tool_call":("session_id","task_id","tool_call_id","tool_name","args"),
 "post_tool_call":("session_id","task_id","tool_call_id","tool_name","args","result","duration_ms"),
 "pre_approval_request":("command","description","pattern_key","pattern_keys","session_key","surface"),
 "post_approval_response":("command","description","pattern_key","pattern_keys","session_key","surface","choice"),
 "on_session_end":("session_id",),"on_session_finalize":("session_id","platform"),"on_session_reset":("session_id","platform")}

def _cut(value:str)->str: return value if len(value)<=MAX_JSONABLE_STRING else value[:MAX_JSONABLE_STRING]+TRUNCATED
def _jsonable(value:Any,depth:int=0,budget:Optional[list[int]]=None)->Any:
 if budget is None: budget=[MAX_JSONABLE_NODES]
 if budget[0]<=0:return TRUNCATED
 budget[0]-=1
 if depth>MAX_JSONABLE_DEPTH:return _cut(repr(value))
 if value is None or isinstance(value,(int,float,bool)):return value
 if isinstance(value,str):return _cut(value)
 if isinstance(value,dict):
  out={}
  for index,(key,item) in enumerate(value.items()):
   if index>=MAX_JSONABLE_ITEMS:out[TRUNCATED]=True;break
   out[_cut(str(key))]=_jsonable(item,depth+1,budget)
  return out
 if isinstance(value,(list,tuple,set)):
  out=[]
  for index,item in enumerate(value):
   if index>=MAX_JSONABLE_ITEMS:out.append(TRUNCATED);break
   out.append(_jsonable(item,depth+1,budget))
  return out
 return _cut(repr(value))

def _env()->dict[str,str]:
 env=dict(os.environ); endpoint=env.get("PEBBLE_AGENT_HOOK_ENDPOINT","")
 if endpoint and os.path.isfile(endpoint):
  try:
   with open(endpoint,"r",encoding="utf-8") as source:
    for raw in source:
     line=raw.strip()
     if not line or line.startswith("#"):continue
     if line.startswith("set "):line=line[4:]
     key,sep,value=line.partition("=")
     if sep and key:env[key]=value
  except OSError:pass
 return env

def _post(payload:dict[str,Any])->None:
 env=_env();port=env.get("PEBBLE_AGENT_HOOK_PORT","");token=env.get("PEBBLE_AGENT_HOOK_TOKEN","");pane=env.get("PEBBLE_PANE_KEY","")
 if not port or not token or not pane:return
 body={"paneKey":pane,"launchToken":env.get("PEBBLE_AGENT_LAUNCH_TOKEN",""),"tabId":env.get("PEBBLE_TAB_ID",""),"worktreeId":env.get("PEBBLE_WORKTREE_ID",""),"env":env.get("PEBBLE_AGENT_HOOK_ENV",""),"version":env.get("PEBBLE_AGENT_HOOK_VERSION",""),"payload":payload}
 request=urllib.request.Request(f"http://127.0.0.1:{port}/hook/hermes",data=json.dumps(body,separators=(",",":")).encode(),method="POST",headers={"Content-Type":"application/json","X-Pebble-Agent-Hook-Token":token})
 try:urllib.request.urlopen(request,timeout=0.75).close()
 except (OSError,urllib.error.URLError):pass

def _payload(event:str,kwargs:dict[str,Any])->dict[str,Any]:
 payload={"hook_event_name":event,"cwd":os.getcwd()}
 for key in SELECTED_KEYS.get(event,()):
  if key in kwargs:payload[key]=_jsonable(kwargs[key])
 if "user_message" in payload:payload["prompt"]=payload["user_message"]
 if "assistant_response" in payload:payload["last_assistant_message"]=payload["assistant_response"]
 if "args" in payload:payload["tool_input"]=payload["args"]
 if event in {"pre_approval_request","post_approval_response"}:payload["tool_name"]="approval";payload["tool_input"]={"command":payload.get("command",""),"description":payload.get("description","")}
 return payload

def _make(event:str)->Callable[...,None]:
 def hook(**kwargs:Any)->None:_post(_payload(event,kwargs))
 return hook
def register(ctx:Any)->None:
 for event in EVENTS:ctx.register_hook(event,_make(event))
`
