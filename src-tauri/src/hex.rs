// Lowercase hex encoding and OS-random identifiers. Self-contained: compiled
// under `sync_core` (which the fuzz crate includes by path) and reached from
// the rest of the crate as `crate::hex`.

use ring::rand::{SecureRandom, SystemRandom};

/// Two lowercase hex digits per byte, high nibble first.
pub fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 15)] as char);
    }
    out
}

/// `N` bytes from the OS secure random source; `None` when it is unavailable.
pub fn random_bytes<const N: usize>() -> Option<[u8; N]> {
    let mut bytes = [0u8; N];
    SystemRandom::new().fill(&mut bytes).ok()?;
    Some(bytes)
}

/// `N` OS-random bytes as `2 * N` lowercase hex digits.
pub fn random_hex<const N: usize>() -> Option<String> {
    random_bytes::<N>().map(|bytes| encode(&bytes))
}

/// A fresh 256-bit bearer token (bridge, resource and HTML-run sessions,
/// request ids). The error text is the one these callers have always shown.
pub fn random_token() -> Result<String, String> {
    random_hex::<32>().ok_or_else(|| "could not generate a secure Pi bridge token".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_lowercase_format_padding() {
        let all: Vec<u8> = (0..=255).collect();
        let expected: String = all.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(encode(&all), expected);
        assert_eq!(encode(&[]), "");
    }

    #[test]
    fn random_hex_has_the_requested_width_and_varies() {
        let first = random_hex::<32>().unwrap();
        let second = random_hex::<32>().unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(random_hex::<16>().unwrap().len(), 32);
        assert!(first
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(first, second);
    }
}
