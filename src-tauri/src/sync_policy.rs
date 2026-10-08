//! Literal listener selection avoids name resolution and accidental wildcard fallback.
pub(crate) fn listener_address(value: &str) -> Result<std::net::IpAddr, String> {
    value
        .parse()
        .map_err(|_| "select a literal local IP address for Receive".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listener_requires_an_explicit_address() {
        for value in [
            "",
            "localhost",
            "tailscale.example",
            "127.0.0.1:8787",
            " 0.0.0.0",
        ] {
            assert!(listener_address(value).is_err());
        }
        assert!(listener_address("127.0.0.1").unwrap().is_loopback());
        assert!(listener_address("0.0.0.0").unwrap().is_unspecified());
        assert!(listener_address("::1").unwrap().is_loopback());
    }
}
