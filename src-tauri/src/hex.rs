// Hex encoding and decoding, SHA-256 digests and OS-random identifiers.
// Self-contained: compiled under `sync_core` (which the fuzz crate includes by
// path) and reached from the rest of the crate as `crate::hex`.

use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};

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

/// Lowercase hex SHA-256 of `bytes`: always 64 digits.
pub fn sha256_hex(bytes: &[u8]) -> String {
    encode(&Sha256::digest(bytes))
}

/// Value of one ASCII hex digit in either case. Unlike `from_str_radix`, never
/// accepts a sign; any other byte, including UTF-8 continuation bytes, is `None`.
pub fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// One byte from a pair of hex digits, high nibble first.
fn pair(digits: &[u8]) -> Option<u8> {
    let (&high, &low) = (digits.first()?, digits.get(1)?);
    Some(nibble(high)? << 4 | nibble(low)?)
}

/// Decodes hex digit pairs in either case. `None` on odd length or any
/// non-hex byte; empty text decodes to no bytes. Works on bytes, so hostile
/// multi-byte text can never split a character or panic.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    bytes.chunks_exact(2).map(pair).collect()
}

/// Decodes exactly `2 * N` hex digits in either case; `None` otherwise.
pub fn decode_exact<const N: usize>(text: &str) -> Option<[u8; N]> {
    let bytes = text.as_bytes();
    if bytes.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (byte, digits) in out.iter_mut().zip(bytes.chunks_exact(2)) {
        *byte = pair(digits)?;
    }
    Some(out)
}

/// Exactly 64 lowercase hex digits: the only accepted spelling of sync keys,
/// manifest content hashes and certificate fingerprints. Uppercase is rejected.
pub fn is_lowercase_hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

    #[test]
    fn sha256_hex_is_lowercase_digest_text() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        for input in [&b""[..], b"old", &[0u8, 255, 16, 1][..]] {
            assert_eq!(sha256_hex(input), format!("{:x}", Sha256::digest(input)));
            assert!(is_lowercase_hex64(&sha256_hex(input)));
        }
    }

    /// Every byte decodes exactly as `char::to_digit(16)` does: both cases,
    /// no sign, no non-ASCII byte.
    #[test]
    fn nibble_accepts_exactly_the_hex_digits() {
        for byte in 0..=u8::MAX {
            let expected = (byte as char).to_digit(16).map(|digit| digit as u8);
            assert_eq!(nibble(byte), expected, "{byte:#x}");
        }
    }

    /// Acceptance set shared by the vault write path header and transaction
    /// byte fields: any case, even length, empty allowed.
    #[test]
    fn decode_accepts_even_hex_in_either_case() {
        let cases: &[(&str, Option<&[u8]>)] = &[
            ("", Some(&[])),
            ("00ff", Some(&[0, 255])),
            ("00FF", Some(&[0, 255])),
            ("aB", Some(&[0xab])),
            ("0", None),
            ("abc", None),
            ("0g", None),
            ("+f", None),
            ("-1", None),
            (" 1", None),
            ("€0", None),
            ("0€", None),
        ];
        for (text, expected) in cases {
            assert_eq!(decode(text).as_deref(), *expected, "{text:?}");
        }
    }

    /// Acceptance set of sync key-exchange fields: exact width, any case.
    #[test]
    fn decode_exact_requires_the_exact_width() {
        let zeros = "0".repeat(64);
        assert_eq!(decode_exact::<32>(&zeros), Some([0u8; 32]));
        assert_eq!(decode_exact::<2>("00FF"), Some([0, 255]));
        assert_eq!(decode_exact::<2>("00ff"), Some([0, 255]));
        assert_eq!(decode_exact::<0>(""), Some([]));
        for wrong in [
            "", "00", "00f", "00ff0", "00ff00", "00+f", "00fg", "0€", "€0",
        ] {
            assert_eq!(decode_exact::<2>(wrong), None, "{wrong:?}");
        }
        for odd in ["", "0", "€", "0€", "€0", "ab€"] {
            assert_eq!(decode_exact::<1>(odd), None, "{odd:?}");
        }
    }

    /// Acceptance set of sync keys, manifest hashes and fingerprints.
    #[test]
    fn lowercase_hex64_rejects_case_width_and_non_hex() {
        let valid = "0123456789abcdef".repeat(4);
        assert!(is_lowercase_hex64(&valid));
        assert!(!is_lowercase_hex64(&valid.to_uppercase()));
        assert!(!is_lowercase_hex64(&format!("{}A", &valid[..63])));
        assert!(!is_lowercase_hex64(&valid[..63]));
        assert!(!is_lowercase_hex64(&format!("{valid}0")));
        assert!(!is_lowercase_hex64(&format!("{}g", &valid[..63])));
        assert!(!is_lowercase_hex64(&format!("{}€", &valid[..61])));
        assert!(!is_lowercase_hex64(""));
    }
}
