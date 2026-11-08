#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let e = CommandError {
            code: "store.io".to_string(),
            message: "disk full".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"code":"store.io","message":"disk full"}"#
        );
        assert_eq!(e.clone(), e);
    }
}
