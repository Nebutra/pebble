use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use sysinfo::Networks;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceAddress {
    pub name: String,
    pub address: String,
}

#[tauri::command]
pub fn network_list_interfaces() -> Result<Vec<NetworkInterfaceAddress>, String> {
    Ok(collect_pairable_interfaces(
        enumerate_interface_addresses(),
        default_route_address(),
    ))
}

fn enumerate_interface_addresses() -> Vec<(String, Ipv4Addr)> {
    let networks = Networks::new_with_refreshed_list();
    let mut addresses = Vec::new();
    for (name, data) in &networks {
        for network in data.ip_networks() {
            if let IpAddr::V4(address) = network.addr {
                addresses.push((name.clone(), address));
            }
        }
    }
    addresses
}

// Why: UDP connect performs local route selection without sending packets,
// giving every supported OS the address a phone would most likely reach. It is
// only a ranking hint now — under a proxy the default route is the TUN device.
fn default_route_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(address) if is_pairable_address(address) => Some(address),
        _ => None,
    }
}

fn collect_pairable_interfaces(
    addresses: Vec<(String, Ipv4Addr)>,
    default_route: Option<Ipv4Addr>,
) -> Vec<NetworkInterfaceAddress> {
    let mut pairable: Vec<(String, Ipv4Addr)> = addresses
        .into_iter()
        .filter(|(_, address)| is_pairable_address(*address))
        .collect();
    pairable.sort_by_key(|(name, address)| {
        (
            // The route the OS would pick is the one most likely to work, so it
            // leads the list the picker defaults to.
            default_route != Some(*address),
            address.octets(),
            name.clone(),
        )
    });
    pairable.dedup_by_key(|(_, address)| *address);

    let mut interfaces: Vec<NetworkInterfaceAddress> = pairable
        .into_iter()
        .map(|(name, address)| NetworkInterfaceAddress {
            name,
            address: address.to_string(),
        })
        .collect();
    // A default route the enumeration missed is still better than nothing —
    // some platforms hide the interface backing it from the adapter list.
    if let Some(address) = default_route {
        let address = address.to_string();
        if !interfaces.iter().any(|entry| entry.address == address) {
            interfaces.insert(
                0,
                NetworkInterfaceAddress {
                    name: "Default route".to_string(),
                    address,
                },
            );
        }
    }
    interfaces
}

// Why: a phone dials this address directly, so anything that is not routable
// from another host is worse than no entry at all. The reserved ranges below
// are what a local proxy (Clash/Mihomo, Surge) hands its fake-ip TUN device;
// advertising one produces a QR that scans fine and then never connects.
// Tailscale's 100.64.0.0/10 is deliberately kept — it is the range that makes
// cross-network pairing work at all.
fn is_pairable_address(address: Ipv4Addr) -> bool {
    if address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_link_local()
        || address.is_documentation()
    {
        return false;
    }
    let [a, b, ..] = address.octets();
    // 198.18.0.0/15 is RFC 2544 benchmarking space and the default fake-ip
    // range; 240.0.0.0/4 is reserved and used the same way; 192.0.0.0/24 is
    // IETF protocol assignment space.
    let fake_ip = (a == 198 && (b == 18 || b == 19)) || a >= 240 || (a == 192 && b == 0);
    !fake_ip
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addresses(values: &[(&str, &str)]) -> Vec<(String, Ipv4Addr)> {
        values
            .iter()
            .map(|(name, address)| ((*name).to_string(), address.parse().unwrap()))
            .collect()
    }

    #[test]
    fn drops_addresses_a_phone_could_never_dial() {
        let listed = collect_pairable_interfaces(
            addresses(&[
                ("lo0", "127.0.0.1"),
                ("utun7", "198.18.0.1"),
                ("utun8", "198.19.0.1"),
                ("en5", "240.0.0.1"),
                ("en6", "169.254.10.2"),
                ("en7", "192.0.0.8"),
                ("en0", "192.168.1.50"),
            ]),
            None,
        );
        let found: Vec<&str> = listed.iter().map(|entry| entry.address.as_str()).collect();
        assert_eq!(found, vec!["192.168.1.50"]);
    }

    #[test]
    fn keeps_a_tailnet_address_out_of_the_fake_ip_filter() {
        let listed = collect_pairable_interfaces(addresses(&[("utun4", "100.101.102.103")]), None);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].address, "100.101.102.103");
    }

    #[test]
    fn leads_with_the_default_route() {
        let listed = collect_pairable_interfaces(
            addresses(&[("en0", "192.168.1.50"), ("utun4", "100.101.102.103")]),
            Some("192.168.1.50".parse().unwrap()),
        );
        assert_eq!(listed[0].address, "192.168.1.50");
        assert_eq!(listed[1].address, "100.101.102.103");
    }

    #[test]
    fn adds_a_default_route_the_enumeration_missed() {
        let listed = collect_pairable_interfaces(
            addresses(&[("en0", "192.168.1.50")]),
            Some("10.0.0.4".parse().unwrap()),
        );
        assert_eq!(listed[0].address, "10.0.0.4");
        assert_eq!(listed[0].name, "Default route");
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn reports_one_entry_per_address() {
        let listed = collect_pairable_interfaces(
            addresses(&[("en0", "192.168.1.50"), ("bridge0", "192.168.1.50")]),
            None,
        );
        assert_eq!(listed.len(), 1);
    }
}
