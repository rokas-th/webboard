pub(crate) const USER_AGENT: &str = concat!(
    "WebBoard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://webboard.rokass.org)"
);

pub(crate) fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().user_agent(USER_AGENT)
}

pub(crate) fn innermost(e: &(dyn std::error::Error + 'static)) -> String {
    std::iter::successors(Some(e), |cur| cur.source())
        .last()
        .map_or_else(|| e.to_string(), ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Layer(&'static str, Option<Box<Layer>>);

    impl std::fmt::Display for Layer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1
                .as_deref()
                .map(|l| l as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn innermost_names_the_deepest_cause() {
        let e = Layer(
            "outer",
            Some(Box::new(Layer(
                "middle",
                Some(Box::new(Layer("root", None))),
            ))),
        );
        assert_eq!(innermost(&e), "root");
        assert_eq!(innermost(&Layer("alone", None)), "alone");
    }

    #[test]
    fn the_user_agent_names_webboard_and_its_version() {
        assert_eq!(
            USER_AGENT,
            format!(
                "WebBoard/{} (+https://webboard.rokass.org)",
                env!("CARGO_PKG_VERSION")
            )
        );
    }
}
