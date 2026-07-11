use std::fs;

use super::{
    error_status, home_dir, AgentHookInstallState, AgentHookInstallStatus, ClaudeCompatibleSettings,
};

const FILE_NAME: &str = "pebble-agent-status.ts";
const MARKER: &str = "Managed by Pebble. Do not edit; changes may be overwritten.";
const REQUIRED: &[&str] = &[
    "/hook/amp",
    "amp.on('session.start'",
    "amp.on('agent.start'",
    "amp.on('tool.call'",
    "amp.on('tool.result'",
    "amp.on('agent.end'",
];
const SETTINGS: ClaudeCompatibleSettings = ClaudeCompatibleSettings {
    agent: "amp",
    config_dir_name: ".config",
    script_base_name: "amp-plugin",
};

const PLUGIN: &str = r#"import { readFileSync, statSync } from 'fs'
import type { PluginAPI } from '@ampcode/plugin'

// Managed by Pebble. Do not edit; changes may be overwritten.
type Coords = { port?: string; token?: string; env?: string; version?: string }
let endpointKey = ''
let endpointCache: Coords | null = null
function endpoint(): Coords {
  const path = process.env.PEBBLE_AGENT_HOOK_ENDPOINT
  if (path) try {
    const stat = statSync(path)
    const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    if (key !== endpointKey || !endpointCache) {
      const out: Coords = {}
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/)
        if (!match) continue
        if (match[1] === 'PEBBLE_AGENT_HOOK_PORT') out.port = match[2]
        if (match[1] === 'PEBBLE_AGENT_HOOK_TOKEN') out.token = match[2]
        if (match[1] === 'PEBBLE_AGENT_HOOK_ENV') out.env = match[2]
        if (match[1] === 'PEBBLE_AGENT_HOOK_VERSION') out.version = match[2]
      }
      endpointKey = key; endpointCache = out
    }
  } catch { endpointKey = ''; endpointCache = null }
  return endpointCache ?? {}
}
function safe(value: unknown, depth = 0): unknown {
  if (value == null || ['string','number','boolean'].includes(typeof value)) return value
  if (depth >= 4) return String(value).slice(0, 4000)
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safe(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, child]) => [key, safe(child, depth + 1)]))
  return String(value)
}
async function post(name: string, payload: Record<string, unknown>): Promise<void> {
  const file = endpoint(), port = file.port || process.env.PEBBLE_AGENT_HOOK_PORT, token = file.token || process.env.PEBBLE_AGENT_HOOK_TOKEN
  const paneKey = process.env.PEBBLE_PANE_KEY
  if (!port || !token || !paneKey) return
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 1000)
  try { await fetch(`http://127.0.0.1:${port}/hook/amp`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Pebble-Agent-Hook-Token': token }, body: JSON.stringify({ paneKey, tabId: process.env.PEBBLE_TAB_ID || '', launchToken: process.env.PEBBLE_AGENT_LAUNCH_TOKEN || '', worktreeId: process.env.PEBBLE_WORKTREE_ID || '', env: file.env || process.env.PEBBLE_AGENT_HOOK_ENV || '', version: file.version || process.env.PEBBLE_AGENT_HOOK_VERSION || '', hook_event_name: name, payload: { hook_event_name: name, ...payload } }) }) } catch {} finally { clearTimeout(timeout) }
}
const MAX_PENDING_POSTS = 50
type QueuedPost = { name: string; payload: Record<string, unknown> }
let postQueue: QueuedPost[] = [], draining = false
async function drain(): Promise<void> { if (draining) return; draining = true; try { while (postQueue.length) { const item = postQueue.shift(); if (item) await post(item.name, item.payload) } } finally { draining = false; if (postQueue.length) void drain() } }
function enqueuePost(name: string, payload: Record<string, unknown>): void { if (postQueue.length >= MAX_PENDING_POSTS) postQueue.shift(); postQueue.push({ name, payload }); void drain() }
export default function (amp: PluginAPI) {
  amp.on('session.start', event => enqueuePost('session.start', { threadId: event.thread.id }))
  amp.on('agent.start', event => enqueuePost('agent.start', { threadId: event.thread.id, id: event.id, message: event.message }))
  amp.on('tool.call', event => { enqueuePost('tool.call', { threadId: event.thread.id, toolUseId: event.toolUseID, tool: event.tool, input: safe(event.input) }); return { action: 'allow' } })
  amp.on('tool.result', event => enqueuePost('tool.result', { threadId: event.thread.id, toolUseId: event.toolUseID, tool: event.tool, input: safe(event.input), status: event.status, error: event.error, output: String(event.output ?? '').slice(0, 4000) }))
  amp.on('agent.end', event => enqueuePost('agent.end', { threadId: event.thread.id, id: event.id, message: event.message, status: event.status }))
}
"#;

fn path() -> Option<std::path::PathBuf> {
    home_dir().map(|home| {
        home.join(".config")
            .join("amp")
            .join("plugins")
            .join(FILE_NAME)
    })
}
fn read() -> Result<Option<String>, String> {
    let Some(path) = path() else {
        return Err("Could not resolve Amp plugin path.".into());
    };
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
fn managed(text: &str) -> bool {
    text.contains(MARKER)
}
fn complete(text: &str) -> bool {
    managed(text) && REQUIRED.iter().all(|needle| text.contains(needle))
}

pub(super) fn status() -> AgentHookInstallStatus {
    let path_text = path()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    match read() {
        Ok(None) => AgentHookInstallStatus {
            agent: "amp",
            state: AgentHookInstallState::NotInstalled,
            config_path: path_text,
            managed_hooks_present: false,
            detail: None,
        },
        Ok(Some(text)) if !managed(&text) => AgentHookInstallStatus {
            agent: "amp",
            state: AgentHookInstallState::Partial,
            config_path: path_text,
            managed_hooks_present: false,
            detail: Some("Amp Pebble status plugin exists but is not Pebble-managed".into()),
        },
        Ok(Some(text)) => AgentHookInstallStatus {
            agent: "amp",
            state: if complete(&text) {
                AgentHookInstallState::Installed
            } else {
                AgentHookInstallState::Partial
            },
            config_path: path_text,
            managed_hooks_present: true,
            detail: (!complete(&text))
                .then(|| "Managed Amp plugin is missing required handlers".into()),
        },
        Err(detail) => error_status(&SETTINGS, path_text, detail),
    }
}

pub(super) fn apply(enabled: bool) -> AgentHookInstallStatus {
    let Some(path) = path() else {
        return error_status(
            &SETTINGS,
            String::new(),
            "Could not resolve Amp plugin path.".into(),
        );
    };
    let result = (|| -> Result<(), String> {
        let existing = read()?;
        if existing.as_deref().is_some_and(|text| !managed(text)) {
            return Ok(());
        }
        if enabled {
            fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
            let temporary = path
                .parent()
                .unwrap()
                .join(format!(".amp-{}.tmp", uuid::Uuid::new_v4()));
            fs::write(&temporary, PLUGIN).map_err(|error| error.to_string())?;
            fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        } else if existing.as_deref().is_some_and(managed) {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => status(),
        Err(detail) => error_status(&SETTINGS, path.display().to_string(), detail),
    }
}
