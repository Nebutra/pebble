use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySessionInput {
    session_id: String,
    pane_key: Option<String>,
    pid: u32,
    worktree_id: String,
    worktree_name: String,
    repo_id: String,
    repo_name: String,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageValues {
    cpu: f32,
    memory: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMemory {
    session_id: String,
    pane_key: Option<String>,
    pid: u32,
    cpu: f32,
    memory: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeMemory {
    worktree_id: String,
    worktree_name: String,
    repo_id: String,
    repo_name: String,
    cpu: f32,
    memory: u64,
    sessions: Vec<SessionMemory>,
    history: Vec<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMemory {
    cpu: f32,
    memory: u64,
    main: UsageValues,
    renderer: UsageValues,
    other: UsageValues,
    history: Vec<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostMemory {
    total_memory: u64,
    free_memory: u64,
    used_memory: u64,
    memory_usage_percent: f64,
    cpu_core_count: usize,
    load_average_1m: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    app: AppMemory,
    worktrees: Vec<WorktreeMemory>,
    host: HostMemory,
    total_cpu: f32,
    total_memory: u64,
    collected_at: u128,
}

#[tauri::command]
pub fn diagnostics_memory_snapshot(sessions: Vec<MemorySessionInput>) -> MemorySnapshot {
    let mut system = System::new_all();
    std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_processes(ProcessesToUpdate::All, true);
    system.refresh_memory();

    let main = process_tree_usage(&system, std::process::id(), &mut HashSet::new());
    let mut buckets: HashMap<String, WorktreeMemory> = HashMap::new();
    let mut claimed = HashSet::new();
    for input in sessions {
        let usage = process_tree_usage(&system, input.pid, &mut claimed);
        let bucket = buckets
            .entry(input.worktree_id.clone())
            .or_insert_with(|| WorktreeMemory {
                worktree_id: input.worktree_id,
                worktree_name: input.worktree_name,
                repo_id: input.repo_id,
                repo_name: input.repo_name,
                cpu: 0.0,
                memory: 0,
                sessions: Vec::new(),
                history: Vec::new(),
            });
        bucket.cpu += usage.cpu;
        bucket.memory += usage.memory;
        bucket.sessions.push(SessionMemory {
            session_id: input.session_id,
            pane_key: input.pane_key,
            pid: input.pid,
            cpu: usage.cpu,
            memory: usage.memory,
        });
    }
    let mut worktrees: Vec<_> = buckets.into_values().collect();
    worktrees.sort_by(|left, right| left.worktree_name.cmp(&right.worktree_name));
    let session_cpu: f32 = worktrees.iter().map(|item| item.cpu).sum();
    let session_memory: u64 = worktrees.iter().map(|item| item.memory).sum();
    let total = system.total_memory();
    let free = system.free_memory();
    let used = total.saturating_sub(free);
    let load = System::load_average();
    MemorySnapshot {
        app: AppMemory {
            cpu: main.cpu,
            memory: main.memory,
            main,
            renderer: UsageValues::default(),
            other: UsageValues::default(),
            history: Vec::new(),
        },
        worktrees,
        host: HostMemory {
            total_memory: total,
            free_memory: free,
            used_memory: used,
            memory_usage_percent: if total > 0 {
                used as f64 / total as f64 * 100.0
            } else {
                0.0
            },
            cpu_core_count: system.cpus().len().max(1),
            load_average_1m: load.one.max(0.0),
        },
        total_cpu: main.cpu + session_cpu,
        total_memory: main.memory + session_memory,
        collected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default(),
    }
}

fn process_tree_usage(system: &System, root: u32, claimed: &mut HashSet<u32>) -> UsageValues {
    let mut usage = UsageValues::default();
    let mut pending = vec![root];
    while let Some(pid) = pending.pop() {
        if !claimed.insert(pid) {
            continue;
        }
        if let Some(process) = system.process(Pid::from_u32(pid)) {
            usage.cpu += process.cpu_usage();
            usage.memory += process.memory();
        }
        for (child_pid, process) in system.processes() {
            if process.parent().map(|parent| parent.as_u32()) == Some(pid) {
                pending.push(child_pid.as_u32());
            }
        }
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_real_host_and_main_process_metrics() {
        let snapshot = diagnostics_memory_snapshot(Vec::new());
        assert!(snapshot.host.total_memory > 0);
        assert!(snapshot.host.cpu_core_count > 0);
        assert!(snapshot.app.memory > 0);
    }
}
