use std::env;
use std::process;

use pebble_rust_host::{
    run_host_command, HostCommand, HostCommandOutput, RuntimeStatusCommand, RuntimeTransportState,
    DEFAULT_RUNTIME_URL,
};

fn main() {
    let runtime_url = env::args()
        .nth(1)
        .or_else(|| env::var("PEBBLE_RUNTIME_URL").ok())
        .unwrap_or_else(|| DEFAULT_RUNTIME_URL.to_string());
    let bearer_token = env::var("PEBBLE_RUNTIME_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());

    let output = run_host_command(HostCommand::ProbeRuntimeStatus(RuntimeStatusCommand {
        runtime_url,
        bearer_token,
        ..RuntimeStatusCommand::default()
    }));

    let result = match output {
        HostCommandOutput::RuntimeStatus(result) => result,
        HostCommandOutput::RuntimeResource(_) => {
            eprintln!("unexpected runtime resource output");
            process::exit(1);
        }
    };
    println!("runtime_url={}", result.runtime_url);
    println!("request_path={}", result.request_path);
    println!("transport={}", result.transport.as_str());

    if let Some(status) = result.http_status {
        println!("http_status={}", status);
    }
    if let Some(version) = result.contract_version.as_deref() {
        println!("contract_version={}", version);
    }
    if let Some(matches) = result.contract_version_matches {
        println!("contract_version_matches={}", matches);
    }
    if let Some(state) = result.service_state.as_deref() {
        println!("service_state={}", state);
    }
    if let Some(error) = result.error.as_deref() {
        eprintln!("error={}", error);
    }

    if result.transport != RuntimeTransportState::Connected {
        process::exit(1);
    }
}
