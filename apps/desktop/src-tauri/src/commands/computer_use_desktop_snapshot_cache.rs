use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde_json::Value;

const MAX_SNAPSHOTS: usize = 32;
const MAX_AGE: Duration = Duration::from_secs(2 * 60);

struct CachedAlias {
    generation: u64,
    value: Value,
}

struct SnapshotEntry {
    created_at: Instant,
    generation: u64,
    keys: Vec<String>,
}

#[derive(Default)]
pub struct DesktopSnapshotCache {
    aliases: HashMap<String, CachedAlias>,
    entries: VecDeque<SnapshotEntry>,
    next_generation: u64,
}

impl DesktopSnapshotCache {
    pub fn remember(&mut self, keys: Vec<String>, value: Value) {
        self.next_generation = self.next_generation.wrapping_add(1);
        let generation = self.next_generation;
        for key in &keys {
            self.aliases.insert(
                key.clone(),
                CachedAlias {
                    generation,
                    value: value.clone(),
                },
            );
        }
        self.entries.push_back(SnapshotEntry {
            created_at: Instant::now(),
            generation,
            keys,
        });
        self.prune();
    }

    pub fn get(&mut self, key: &str) -> Option<&Value> {
        self.prune();
        self.aliases.get(key).map(|entry| &entry.value)
    }

    fn prune(&mut self) {
        while self.entries.front().is_some_and(|entry| {
            self.entries.len() > MAX_SNAPSHOTS || entry.created_at.elapsed() > MAX_AGE
        }) {
            let Some(expired) = self.entries.pop_front() else {
                break;
            };
            for key in expired.keys {
                // New snapshots may reuse an alias; preserve the newer generation.
                if self.aliases.get(&key).map(|entry| entry.generation) == Some(expired.generation)
                {
                    self.aliases.remove(&key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DesktopSnapshotCache, MAX_SNAPSHOTS};

    #[test]
    fn bounds_history_without_removing_reused_aliases() {
        let mut cache = DesktopSnapshotCache::default();
        cache.remember(vec!["app".into(), "old-only".into()], json!({"version": 0}));
        for version in 1..=MAX_SNAPSHOTS {
            cache.remember(
                vec!["app".into(), format!("window-{version}")],
                json!({"version": version}),
            );
        }

        assert_eq!(cache.get("app"), Some(&json!({"version": MAX_SNAPSHOTS})));
        assert_eq!(cache.get("old-only"), None);
        assert_eq!(cache.get("window-1"), Some(&json!({"version": 1})));
    }
}
