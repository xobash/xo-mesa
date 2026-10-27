pub fn matches(value: &str, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, token.as_bytes());
    let tag = ring::hmac::sign(&key, expected.as_bytes());
    ring::hmac::verify(&key, value.as_bytes(), tag.as_ref()).is_ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn bearer_requires_exact_value() {
        assert!(super::matches("Bearer secret", "secret"));
        assert!(!super::matches("Bearer other", "secret"));
        assert!(!super::matches("bearer secret", "secret"));
    }
}
