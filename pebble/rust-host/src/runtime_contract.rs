pub const RUNTIME_API_VERSION: &str = "pebble.runtime.v1";
pub const RUNTIME_EVENT_VERSION: &str = "pebble.events.v1";
pub const RUNTIME_STATUS_PATH: &str = "/v1/status";
pub const RUNTIME_EVENTS_PATH: &str = "/v1/events";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeHttpMethod {
    Get,
    Post,
    Patch,
    Delete,
    Stream,
}

impl RuntimeHttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Stream => "STREAM",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeResourceName {
    Status,
    Events,
    Projects,
    Worktrees,
    Sessions,
    Agents,
    Orchestration,
    Automations,
    ExternalTasks,
    SourceControl,
    Files,
    Releases,
    Settings,
    Browser,
    Computer,
    Emulator,
    Providers,
    MobileRelay,
}

impl RuntimeResourceName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Events => "events",
            Self::Projects => "projects",
            Self::Worktrees => "worktrees",
            Self::Sessions => "sessions",
            Self::Agents => "agents",
            Self::Orchestration => "orchestration",
            Self::Automations => "automations",
            Self::ExternalTasks => "externalTasks",
            Self::SourceControl => "sourceControl",
            Self::Files => "files",
            Self::Releases => "releases",
            Self::Settings => "settings",
            Self::Browser => "browser",
            Self::Computer => "computer",
            Self::Emulator => "emulator",
            Self::Providers => "providers",
            Self::MobileRelay => "mobileRelay",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeResourceContract {
    pub name: RuntimeResourceName,
    pub path: &'static str,
    pub methods: &'static [RuntimeHttpMethod],
    pub routes: &'static [RuntimeResourceRouteContract],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeResourceRouteContract {
    pub name: &'static str,
    pub path: &'static str,
    pub methods: &'static [RuntimeHttpMethod],
}

const STATUS_METHODS: &[RuntimeHttpMethod] = &[RuntimeHttpMethod::Get];
const EVENT_METHODS: &[RuntimeHttpMethod] = &[RuntimeHttpMethod::Stream];
const PROJECT_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
];
const WORKTREE_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Delete,
];
const SESSION_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const AGENT_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const ORCHESTRATION_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const AUTOMATION_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const EXTERNAL_TASK_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const SOURCE_CONTROL_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Stream,
];
const FILE_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Stream,
];
const RELEASE_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
];
const SETTING_METHODS: &[RuntimeHttpMethod] = &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post];
const BROWSER_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const COMPUTER_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Stream,
];
const EMULATOR_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Patch,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const MOBILE_RELAY_METHODS: &[RuntimeHttpMethod] = &[
    RuntimeHttpMethod::Get,
    RuntimeHttpMethod::Post,
    RuntimeHttpMethod::Delete,
    RuntimeHttpMethod::Stream,
];
const PROVIDER_METHODS: &[RuntimeHttpMethod] = &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post];
const NO_ROUTES: &[RuntimeResourceRouteContract] = &[];
const PROVIDER_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "providers",
        path: "/v1/providers",
        methods: &[RuntimeHttpMethod::Get],
    },
    RuntimeResourceRouteContract {
        name: "providerRegistration",
        path: "/v1/providers",
        methods: &[RuntimeHttpMethod::Post],
    },
];
const PROJECT_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "projects",
        path: "/v1/projects",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "project",
        path: "/v1/projects/{id}",
        methods: &[RuntimeHttpMethod::Patch, RuntimeHttpMethod::Delete],
    },
];
const WORKTREE_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "worktrees",
        path: "/v1/worktrees",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "worktree",
        path: "/v1/worktrees/{id}",
        methods: &[RuntimeHttpMethod::Delete],
    },
];
const AGENT_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "profiles",
        path: "/v1/agents/profiles",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "profile",
        path: "/v1/agents/profiles/{id}",
        methods: &[RuntimeHttpMethod::Patch, RuntimeHttpMethod::Delete],
    },
    RuntimeResourceRouteContract {
        name: "runs",
        path: "/v1/agents/runs",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "run",
        path: "/v1/agents/runs/{id}",
        methods: &[RuntimeHttpMethod::Delete],
    },
];
const ORCHESTRATION_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "tasks",
        path: "/v1/orchestration/tasks",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "task",
        path: "/v1/orchestration/tasks/{id}",
        methods: &[RuntimeHttpMethod::Patch],
    },
    RuntimeResourceRouteContract {
        name: "messages",
        path: "/v1/orchestration/messages",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "messageReply",
        path: "/v1/orchestration/messages/{id}/reply",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "dispatches",
        path: "/v1/orchestration/dispatches",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "dispatch",
        path: "/v1/orchestration/dispatches/{id}",
        methods: &[RuntimeHttpMethod::Patch],
    },
];
const AUTOMATION_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "automations",
        path: "/v1/automations",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "automation",
        path: "/v1/automations/{id}",
        methods: &[RuntimeHttpMethod::Patch, RuntimeHttpMethod::Delete],
    },
    RuntimeResourceRouteContract {
        name: "runs",
        path: "/v1/automations/runs",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "automationRuns",
        path: "/v1/automations/{id}/runs",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "evaluate",
        path: "/v1/automations/evaluate",
        methods: &[RuntimeHttpMethod::Post],
    },
];
const EXTERNAL_TASK_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "items",
        path: "/v1/external-tasks",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "item",
        path: "/v1/external-tasks/{id}",
        methods: &[RuntimeHttpMethod::Patch, RuntimeHttpMethod::Delete],
    },
];
const SOURCE_CONTROL_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "projections",
        path: "/v1/source-control",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "projectionUpdates",
        path: "/v1/source-control/projections",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "status",
        path: "/v1/source-control/status",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "diff",
        path: "/v1/source-control/diff",
        methods: STATUS_METHODS,
    },
];
const FILE_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "tree",
        path: "/v1/files/tree",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "read",
        path: "/v1/files/read",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "write",
        path: "/v1/files/write",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "treeSnapshots",
        path: "/v1/files/tree-snapshots",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "contentSnapshots",
        path: "/v1/files/content-snapshots",
        methods: &[RuntimeHttpMethod::Post],
    },
];
const RELEASE_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "plans",
        path: "/v1/releases",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "plan",
        path: "/v1/releases/{id}",
        methods: &[RuntimeHttpMethod::Patch],
    },
    RuntimeResourceRouteContract {
        name: "artifacts",
        path: "/v1/releases/{id}/artifacts",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "checks",
        path: "/v1/releases/{id}/checks",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "manifest",
        path: "/v1/releases/{id}/manifest",
        methods: &[RuntimeHttpMethod::Get],
    },
    RuntimeResourceRouteContract {
        name: "publish",
        path: "/v1/releases/{id}/publish",
        methods: &[RuntimeHttpMethod::Post],
    },
];
const SETTING_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "settings",
        path: "/v1/settings",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "keybindings",
        path: "/v1/settings/keybindings",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
];
const BROWSER_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "tabs",
        path: "/v1/browser/tabs",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "tab",
        path: "/v1/browser/tabs/{id}",
        methods: &[RuntimeHttpMethod::Patch, RuntimeHttpMethod::Delete],
    },
    RuntimeResourceRouteContract {
        name: "tabCommands",
        path: "/v1/browser/tabs/{id}/commands",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "profiles",
        path: "/v1/browser/profiles",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "permissions",
        path: "/v1/browser/permissions",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "downloads",
        path: "/v1/browser/downloads",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "download",
        path: "/v1/browser/downloads/{id}",
        methods: &[RuntimeHttpMethod::Patch],
    },
    RuntimeResourceRouteContract {
        name: "downloadCommands",
        path: "/v1/browser/downloads/{id}/commands/start",
        methods: &[RuntimeHttpMethod::Post],
    },
];
const COMPUTER_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "actions",
        path: "/v1/computer/actions",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "claimActions",
        path: "/v1/computer/actions/claim",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "action",
        path: "/v1/computer/actions/{id}",
        methods: &[RuntimeHttpMethod::Patch],
    },
];
const EMULATOR_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "devices",
        path: "/v1/emulator/devices",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "device",
        path: "/v1/emulator/devices/{id}",
        methods: &[RuntimeHttpMethod::Patch],
    },
    RuntimeResourceRouteContract {
        name: "sessions",
        path: "/v1/emulator/sessions",
        methods: &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "session",
        path: "/v1/emulator/sessions/{id}",
        methods: &[RuntimeHttpMethod::Delete],
    },
    RuntimeResourceRouteContract {
        name: "sessionCommands",
        path: "/v1/emulator/sessions/{id}/commands",
        methods: &[RuntimeHttpMethod::Post],
    },
];
const MOBILE_RELAY_ROUTES: &[RuntimeResourceRouteContract] = &[
    RuntimeResourceRouteContract {
        name: "status",
        path: "/v1/mobile-relay/status",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "pairingCodes",
        path: "/v1/mobile-relay/pairing-codes",
        methods: &[RuntimeHttpMethod::Post],
    },
    RuntimeResourceRouteContract {
        name: "pairings",
        path: "/v1/mobile-relay/pairings",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "projection",
        path: "/v1/mobile-relay/projection",
        methods: STATUS_METHODS,
    },
    RuntimeResourceRouteContract {
        name: "websocket",
        path: "/v1/mobile-relay",
        methods: &[RuntimeHttpMethod::Stream],
    },
];

pub const RUNTIME_RESOURCES: &[RuntimeResourceContract] = &[
    RuntimeResourceContract {
        name: RuntimeResourceName::Status,
        path: "/v1/status",
        methods: STATUS_METHODS,
        routes: NO_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Events,
        path: RUNTIME_EVENTS_PATH,
        methods: EVENT_METHODS,
        routes: NO_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Projects,
        path: "/v1/projects",
        methods: PROJECT_METHODS,
        routes: PROJECT_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Worktrees,
        path: "/v1/worktrees",
        methods: WORKTREE_METHODS,
        routes: WORKTREE_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Sessions,
        path: "/v1/sessions",
        methods: SESSION_METHODS,
        routes: NO_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Agents,
        path: "/v1/agents",
        methods: AGENT_METHODS,
        routes: AGENT_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Orchestration,
        path: "/v1/orchestration",
        methods: ORCHESTRATION_METHODS,
        routes: ORCHESTRATION_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Automations,
        path: "/v1/automations",
        methods: AUTOMATION_METHODS,
        routes: AUTOMATION_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::ExternalTasks,
        path: "/v1/external-tasks",
        methods: EXTERNAL_TASK_METHODS,
        routes: EXTERNAL_TASK_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::SourceControl,
        path: "/v1/source-control",
        methods: SOURCE_CONTROL_METHODS,
        routes: SOURCE_CONTROL_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Files,
        path: "/v1/files",
        methods: FILE_METHODS,
        routes: FILE_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Releases,
        path: "/v1/releases",
        methods: RELEASE_METHODS,
        routes: RELEASE_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Settings,
        path: "/v1/settings",
        methods: SETTING_METHODS,
        routes: SETTING_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Browser,
        path: "/v1/browser",
        methods: BROWSER_METHODS,
        routes: BROWSER_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Computer,
        path: "/v1/computer",
        methods: COMPUTER_METHODS,
        routes: COMPUTER_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Emulator,
        path: "/v1/emulator",
        methods: EMULATOR_METHODS,
        routes: EMULATOR_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::Providers,
        path: "/v1/providers",
        methods: PROVIDER_METHODS,
        routes: PROVIDER_ROUTES,
    },
    RuntimeResourceContract {
        name: RuntimeResourceName::MobileRelay,
        path: "/v1/mobile-relay",
        methods: MOBILE_RELAY_METHODS,
        routes: MOBILE_RELAY_ROUTES,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_control_routes_include_projection_and_raw_status() {
        let contract = resource(RuntimeResourceName::SourceControl);

        assert!(contract
            .routes
            .iter()
            .any(|route| route.name == "projections" && route.path == "/v1/source-control"));
        assert!(contract.routes.iter().any(|route| {
            route.name == "projectionUpdates" && route.path == "/v1/source-control/projections"
        }));
        assert!(contract
            .routes
            .iter()
            .any(|route| route.name == "status" && route.path == "/v1/source-control/status"));
        assert!(contract
            .routes
            .iter()
            .any(|route| route.name == "diff" && route.path == "/v1/source-control/diff"));
    }

    #[test]
    fn file_routes_include_tree_read_and_write() {
        let route_names: Vec<&str> = resource(RuntimeResourceName::Files)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(
            route_names,
            vec!["tree", "read", "write", "treeSnapshots", "contentSnapshots"]
        );
    }

    #[test]
    fn release_routes_include_artifact_checks_and_publish_gate() {
        let route_names: Vec<&str> = resource(RuntimeResourceName::Releases)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(
            route_names,
            vec![
                "plans",
                "plan",
                "artifacts",
                "checks",
                "manifest",
                "publish"
            ]
        );
    }

    #[test]
    fn settings_routes_include_keybindings() {
        let route_names: Vec<&str> = resource(RuntimeResourceName::Settings)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(route_names, vec!["settings", "keybindings"]);
    }

    #[test]
    fn mobile_relay_routes_include_pairing_projection_and_websocket() {
        let contract = resource(RuntimeResourceName::MobileRelay);
        let route_names: Vec<&str> = contract.routes.iter().map(|route| route.name).collect();

        assert_eq!(
            route_names,
            vec![
                "status",
                "pairingCodes",
                "pairings",
                "projection",
                "websocket"
            ]
        );
    }

    #[test]
    fn computer_routes_include_actions_and_claim() {
        let contract = resource(RuntimeResourceName::Computer);
        let route_names: Vec<&str> = contract.routes.iter().map(|route| route.name).collect();

        assert_eq!(route_names, vec!["actions", "claimActions", "action"]);
    }

    #[test]
    fn browser_routes_include_tab_close() {
        let contract = resource(RuntimeResourceName::Browser);
        let route_names: Vec<&str> = contract.routes.iter().map(|route| route.name).collect();

        assert_eq!(
            route_names,
            vec![
                "tabs",
                "tab",
                "tabCommands",
                "profiles",
                "permissions",
                "downloads",
                "download",
                "downloadCommands"
            ]
        );
    }

    #[test]
    fn project_and_worktree_routes_include_mutation_endpoints() {
        let project_routes: Vec<&str> = resource(RuntimeResourceName::Projects)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();
        let worktree_routes: Vec<&str> = resource(RuntimeResourceName::Worktrees)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(project_routes, vec!["projects", "project"]);
        assert_eq!(worktree_routes, vec!["worktrees", "worktree"]);
    }

    #[test]
    fn agent_routes_include_profile_and_run_mutations() {
        let route_names: Vec<&str> = resource(RuntimeResourceName::Agents)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(route_names, vec!["profiles", "profile", "runs", "run"]);
    }

    #[test]
    fn orchestration_routes_include_dispatch_updates() {
        let route_names: Vec<&str> = resource(RuntimeResourceName::Orchestration)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(
            route_names,
            vec![
                "tasks",
                "task",
                "messages",
                "messageReply",
                "dispatches",
                "dispatch"
            ]
        );
    }

    #[test]
    fn automation_routes_include_runs_and_evaluate() {
        let route_names: Vec<&str> = resource(RuntimeResourceName::Automations)
            .routes
            .iter()
            .map(|route| route.name)
            .collect();

        assert_eq!(
            route_names,
            vec![
                "automations",
                "automation",
                "runs",
                "automationRuns",
                "evaluate"
            ]
        );
    }

    #[test]
    fn external_task_routes_are_provider_neutral() {
        let contract = resource(RuntimeResourceName::ExternalTasks);
        let route_names: Vec<&str> = contract.routes.iter().map(|route| route.name).collect();

        assert_eq!(contract.path, "/v1/external-tasks");
        assert_eq!(route_names, vec!["items", "item"]);
    }

    #[test]
    fn emulator_routes_include_device_updates_and_session_detach() {
        let contract = resource(RuntimeResourceName::Emulator);
        let route_names: Vec<&str> = contract.routes.iter().map(|route| route.name).collect();

        assert_eq!(
            route_names,
            vec![
                "devices",
                "device",
                "sessions",
                "session",
                "sessionCommands"
            ]
        );
    }

    #[test]
    fn providers_resource_declares_registration_endpoint() {
        let contract = resource(RuntimeResourceName::Providers);
        let route_names: Vec<&str> = contract.routes.iter().map(|route| route.name).collect();

        assert_eq!(contract.path, "/v1/providers");
        assert_eq!(
            contract.methods,
            &[RuntimeHttpMethod::Get, RuntimeHttpMethod::Post]
        );
        assert_eq!(route_names, vec!["providers", "providerRegistration"]);
    }

    #[test]
    fn events_resource_declares_stream_endpoint() {
        let contract = resource(RuntimeResourceName::Events);

        assert_eq!(contract.path, "/v1/events");
        assert_eq!(contract.methods, &[RuntimeHttpMethod::Stream]);
    }

    fn resource(name: RuntimeResourceName) -> &'static RuntimeResourceContract {
        RUNTIME_RESOURCES
            .iter()
            .find(|resource| resource.name == name)
            .expect("runtime resource contract exists")
    }
}
