use serde::Serialize;
use std::net::{IpAddr, UdpSocket};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceAddress {
    pub name: String,
    pub address: String,
}

#[tauri::command]
pub fn network_list_interfaces() -> Result<Vec<NetworkInterfaceAddress>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|error| error.to_string())?;
    // Why: UDP connect performs local route selection without sending packets,
    // giving every supported OS a reachable default-route address.
    socket
        .connect("1.1.1.1:80")
        .map_err(|error| error.to_string())?;
    let address = socket.local_addr().map_err(|error| error.to_string())?.ip();
    match address {
        IpAddr::V4(address) if !address.is_loopback() && !address.is_unspecified() => {
            Ok(vec![NetworkInterfaceAddress {
                name: "Default route".to_string(),
                address: address.to_string(),
            }])
        }
        _ => Ok(Vec::new()),
    }
}
