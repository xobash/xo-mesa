//! Dependency-free JSON escaping and query decoding.
// === Wire helpers ========================================================

/// Minimal JSON string escape.
pub fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// One hexadecimal digit; unlike `from_str_radix`, never accepts a sign.
fn nibble(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

/// Percent-decode a URL query value ('+' becomes a space).
pub fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match nibble(bytes[i + 1]).zip(nibble(bytes[i + 2])) {
                Some((high, low)) => {
                    out.push(high << 4 | low);
                    i += 3;
                }
                None => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract one query parameter's decoded value from a raw query string.
pub fn query_param(query: &str, key: &str) -> Option<String> {
    for kv in query.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return Some(url_decode(v));
            }
        }
    }
    None
}

// === Tests ===============================================================
//
// Cross-language vectors: several of these assert the exact same inputs and
// outputs as src/lib/sync.test.ts, pinning the Rust/TS contract.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_decode_requires_two_hex_digits_after_percent() {
        assert_eq!(url_decode("a%2Fb%2fc"), "a/b/c");
        assert_eq!(url_decode("%+5"), "% 5");
        assert_eq!(url_decode("%-1"), "%-1");
        assert_eq!(url_decode("%e2%82%ac+x"), "€ x");
        assert_eq!(url_decode("%4"), "%4");
    }
}
