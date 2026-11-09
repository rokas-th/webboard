#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, CommandError>;

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

    #[test]
    fn new_builds_code_and_message() {
        assert_eq!(
            CommandError::new("store.seq", String::from("seq 3 is not after 3")),
            CommandError {
                code: "store.seq".to_string(),
                message: "seq 3 is not after 3".to_string(),
            }
        );
    }
}
